// Upgrade in place (owner ruling, 2026-09-26): arcs run for days and executor fixes land mid-run, so an
// executor update never forces a new arc. HEAD's executor must adopt an arc an earlier release started and
// finish it. The starting release's executor is extracted from git (`git archive`, RELEASES) and run with its own
// setup, fakes and CLI; the fixture is generated at test time because the runtime state it leaves holds absolute
// paths. Each test runs the M1 fixture (evals/m1) on the starting release to a mid-arc point with live state, stops
// it (or lets it crash at a crash point, below), then finishes the arc on HEAD (same repo, run dir and host dir;
// setup does not re-run; the spec inputs stay as the starting release left them), with HEAD's driver, graded by
// HEAD's check.ts (every criterion passes, and the upgrade forced no park and no new session), or, where the story
// needs arc judgments the M1 scenario format cannot express, with HEAD's CLI and fakes directly.
//
// Which releases: HEAD (1.0.0-dev.24) adopts arcs started on 1.0.0-dev.7 to dev.21, through the defaults of
// src/core/upgrade.ts. Five are covered here. Every unlabelled cell starts its arc on the previous release
// (PREVIOUS_RELEASE, 1.0.0-dev.21). The dev.20 cells retain legacy snapshot and audit-only skip coverage; one cell has dev.21 publish a dev.20 arc's ref. The cells
// labelled `upgrade.dev11.*` start theirs on 1.0.0-dev.11 (DEV11_RELEASE)
// and those labelled `upgrade.dev10.*` on 1.0.0-dev.10 (DEV10_RELEASE): an arc started on each is in flight, so the
// dev.11 and dev.10 defaults are live code. The cells labelled `upgrade.dev16.*` start theirs on 1.0.0-dev.16
// (DEV16_RELEASE): no arc started on dev.16 is in flight, but the dev.16 -> dev.17 defaults are what those dev.10 and
// dev.11 arcs read too, and their cells do not isolate them, so these cells keep them exercised end to end until they
// go. No arc started on dev.7 to dev.9 or on dev.12 to dev.15 is in flight, and no cell starts one.
//
// All five schedule a DAG and keep every M3, M4a and M4b record, so their arcs run on HEAD as they ran on them; an
// arc started without the holistic layer runs with M2 semantics and no new spend unless the architect opts in. Their
// role sets and pressure records are HEAD's. HEAD's walk roles (`walkthrough`, `polishJudge`) are in force only under a
// plan with milestones, which no arc of theirs has, so no walk seat is hashed for them.
//
// Dev.21 adds no read defaults here. What dev.20 lacks of dev.21: a `flake-observed` fact has no `on`, read from its red run's stage (`flakeOnDefault`),
// but these fixtures record no flakes, so `flake-observed.on` is not allowed. Its GitHub issues fields and facts read as
// written and ignored (`issuesIgnored`, the exact `ISSUES_IGNORED` kinds below). Its audit-only `checkpoint-skipped`
// records have no trigger, read as their audit trigger (`checkpointSkipTriggerOf`); only dev20.checkpoint-reentry-with-fixes
// leaves one for HEAD, and that cell explicitly expects the warning once. `spec.design.kind` is a lasting read: a spec no
// approving plan-check has designed yet reads as kind `module`, on dev.20, dev.21 and HEAD. No other default is allowed in an
// unlabelled cell. The summit effort change (xhigh → high) moves dev.20's routing hash; historical hashes alias to today's
// routing for spend without a warning or routing park (asserted by routing-stable).
//
// What dev.16 also lacks of 1.0.0-dev.17 (the `upgrade.dev16.*` cells): its lanes declare `tier`, read as their cadence,
// and its revisions record no systems map, read as none (1.0.0-dev.17, lane topology; src/core/upgrade.ts
// `laneCadenceDefault`, `systemsMapDefault`); its specs carry no design record (kind `module`, `designKindDefault`) and no
// revision pins (links `unpinned`: a lasting state, no default); its plan-check answers carry no `staleLinks` (none
// answered, `planCheckStaleLinksDefault`, propagation) and no design record (`planCheckDesignDefault`); its plan may carry
// `planCheck.shape`, removed (`planCheckShapeDefault`); its arc has no flaky ledger (read as empty at the upgrade,
// `flakyLedgerDefault`); and (proportional review) its gate answers, gate inputs, build answers and approvals predate the
// findings ledger, the delta and the docs-only claim (`gateFindingReviewDefault`, `gateRulingsDefault`, `gateReviewOf`,
// `buildDocsOnlySinceDefault`, `approvalBlobsOf`); and its Claude reader adapted some result files otherwise
// (`earlierReaderResultDefault`). No release from dev.13 to dev.16 changes a record in a way HEAD reads with a default
// (dev.16's additions, an evidence snapshot's `notRegular`, a publication's vision files and the
// `milestone-references-oversize` plan defect, are optional or new kinds), nor does dev.12 record anything differently
// from dev.13 that HEAD reads with a default: dev.13's additions (plan `milestones`, `limits.walkRounds`, a unit's
// `polish`, `finding-opened.milestone`) are optional, absent meaning none for good. So a dev.16 arc on HEAD warns those
// dev.17 defaults and the later issues defaults below. Its seat table is not HEAD's (dev.17 moved plan-check and the
// gate to frontier and build.high to efficient), so under OR-L3 its units re-pin under HEAD's rev and status aliases the
// revs it recorded (PRE_DEV17_BUILTIN_SEATS).
//
// What dev.11 and dev.10 also lack of 1.0.0-dev.12: their judgments ran without the Agent tool and, but for
// plan-check and the checkpoint, without session persistence (a refused answer left unread takes no repair turn on
// HEAD, warned); they voided an approve whose session had a read refused (`read-denied`, whose retry row HEAD keeps);
// their gates recorded no `diffShown` (read as nothing recorded) and no `largeDiff` (read as under the threshold), and
// their gate answers carry no `unreviewed` and no `clusters`; their lens calls attached the diff, not the bounded diff
// (an audit dev.11 left between chunks finds the same chunks on HEAD); and their seat tables are not HEAD's (the gate
// risk ladder, 1.0.0-dev.12, moved gate.med), so under OR-L3 their units re-pin under HEAD's rev without a park and
// status aliases the revs they recorded (PRE_DEV12_BUILTIN_SEATS).
//
// What dev.10 also lacks of 1.0.0-dev.11, each read with its default and warned once on the executor's stderr: an
// apply its CLI queued carries `expectRev` (rebased from the default base) and no `visionEdit` (a declared vision
// edit); its arc lanes declare no `testPaths` and its witnesses no `files` (undeclared, unchecked); its re-entries
// and its checkpoints' `reenter` ops name no `fixes` (adopted as recorded, applied or not: the `fixes` rows bind
// only what dev.11 and later record); and it wrote rulings and spec patches back into the owner's files, which
// HEAD's rebase takes as the files in force. dev.11's applies, re-entries, obligations and in-force inputs are
// HEAD's shape.
//
// A crashed starting release: its executor is armed with a crash trigger (src/core/crash.ts), and its supervisor
// is frozen (SIGSTOP) as soon as it is ready, so no generation of that release recovers the crash; once the
// executor is gone the supervisor is SIGKILLed. HEAD's start takes over the dead claim of the same arc and its
// recovery finishes what that release left open.
//
// The variants (PREVIOUS_RELEASE starts the arc):
//   upgrade.stop-mid-build     unit `slug` merged; `page-id` stopped mid-build (its Codex thread started, its
//                              worktree dirty), so held with an interrupted attempt; `resume` queued through
//                              the previous release's CLI. HEAD continues the same thread.
//   upgrade.reopen-mid-plan-check
//                              unit `slug` merged; `page-id` parked at plan-check on a blocking needs-user
//                              (escalated on its seat and on the escalation seat), its spec edited to rev 2 and
//                              put in force by `roadmap apply` (plan revision 2), re-opened by `resume page-id`
//                              (the needs-user acknowledged), and stopped mid-plan-check, so held. HEAD re-runs
//                              the plan-check and merges it on rev 2, recording no plan revision of its own; the
//                              finished arc then classifies an apply adding a unit as accepted (revision 3).
//   upgrade.park-adopted       unit `slug` merged; `page-id`'s lane killed by a signal twice (blocked, then its
//                              retry) on a calm host (the test waits, bounded, for the previous release's own host
//                              sample to clear: on a busy one it parks it as host pressure), so parked `lane-blocked`
//                              operator-env; its needs-user acknowledged, and the previous release ends the arc.
//                              `resume page-id` (queued through the previous release's CLI) re-runs its lanes on
//                              HEAD, which now pass, and it merges.
//   upgrade.named-cpu-low-host (F18) the plan declares a named resource `cpu`, which both units reserve; `page-id`
//                              stopped mid-build as in stop-mid-build. On a one-CPU host (`taskset -c 0`) HEAD
//                              refuses the DAG arc over the `@cpu` capacity and changes nothing; on this host HEAD
//                              finishes it reserving both the named `cpu` and `@cpu` tokens.
//   upgrade.apply-queued       stopped mid-build, `page-id` left held; on HEAD's running arc the architect's `apply`
//                              (a new `direction`) queued through the previous release's CLI, its body `expectRev`
//                              with no `base` and no `visionEdit`: HEAD rebases it from the default base and applies
//                              it as plan revision 2, the command's bytes unchanged, the default warned.
//   upgrade.rule-on-adopted-arc
//                              stopped mid-build; while `page-id` waits at its lane on HEAD, `roadmap rule` lands
//                              C-3 on the previous release's revision: the docs publication of constraints.md, nothing
//                              written into the owner's files; then `page-id` merges.
//   upgrade.compact-with-adopted-retry
//                              (A5a, H1) `slug`'s resource teardown fails once; the previous release's retry crashes
//                              after its `cleaned` disposition (`retry.after-disposition`), the instance still held;
//                              64 released pairs of another arc fill the index. HEAD's start compacts it: the fillers
//                              go, the previous release's pair stays byte for byte; recovery releases it and the arc
//                              merges.
//   upgrade.opt-in-holistic    stopped mid-build, `page-id` left held; on HEAD the architect's
//                              `apply --vision-edit` adds `holistic` (a vision, one must-hold obligation witnessed by a node-test
//                              lane, L = {invariants}), then `resume page-id`: the baseline job, the drift audit and
//                              a no-op checkpoint, the brake on `page-id`'s candidate, the final audit and a no-op
//                              checkpoint, the close-out, `arc-completed`.
//   upgrade.fingerprint-open-ff
//                              `page-id` approved, the ff open at a crash; HEAD compares the fingerprint byte for byte.
//                              The previous release's gate recorded `diffShown` and `largeDiff`, read as recorded.
//   upgrade.config-without-chain
//                              no chain K in the repo config: no chain row applies to the adopted arc.
//   upgrade.target-kind-fixed  an apply cannot switch the adopted arc to a corpus target (`target-kind-changed`).
//   upgrade.routing-stable     stopped mid-build, `page-id` left held; on HEAD the architect's `apply` (a new
//                              `direction`) and `resume page-id`: HEAD's revision records the role set the previous
//                              release recorded (no walk role in force: no milestones); HEAD's seat table is the previous
//                              release's, but summit effort moves xhigh to high: every judgment on HEAD is under its new
//                              rev; no `routing-changed`; `status` spend resolves every historical metered call.
//   upgrade.reentry-with-fixes
//                              `page-id` parked infeasible at plan-check (a recorded failure); the architect's `apply`
//                              through the previous release's CLI adds `page-id-2` re-entering it with `fixes` naming that
//                              failure, and the previous release is stopped mid-build of it. HEAD's start finds that
//                              revision in force, HEAD merges `page-id-2`, and an apply then classifies as accepted.
//   upgrade.inputs-in-force    `page-id`'s plan-check redirects with a spec patch and `roadmap rule` lands C-3, both on
//                              the previous release, which keeps them in force without writing the owner's files;
//                              stopped mid-build. On HEAD an architect `apply` (a new `direction`) keeps both in force
//                              as plan revision 3, C-3 published once, and nothing writes the owner's files.
//   upgrade.checkpoint-reentry-with-fixes
//                              `page-id` parks infeasible; the architect opts in to `holistic` through the previous
//                              release's CLI (`--vision-edit`); its park checkpoint's bundle re-enters `page-id` as
//                              `page-id-2` naming the failure, the drift audit and its no-op checkpoint settle, and the
//                              previous release is stopped mid-build of `page-id-2`. HEAD merges it (the brake on its
//                              candidate), runs the final audit and checkpoint and completes the arc; an apply then
//                              classifies as accepted.
//   upgrade.vision-edit-queued as opt-in-holistic, the opt-in apply queued through the previous release's CLI with
//                              `--vision-edit`: applied as the declared vision edit, never `vision-leak`; no default.
//   upgrade.checkpoint-answer-unapplied
//                              a corpus arc; `page-id` parks infeasible and the previous release crashes right after its
//                              park checkpoint's call (`checkpoint.after-call`): the recorded answer, a re-entry naming
//                              the failure, undecided. HEAD decides it from the record (no new call, no repair turn),
//                              applies it and merges `page-id-2`.
//   upgrade.corpus-witnesses-declared
//                              a corpus arc (the previous release's corpus target: pin, Phase-0 record, fake forge)
//                              whose arc lane declares `testPaths` and whose witness declares `files`; stopped mid-build.
//                              HEAD finishes it (the brake, the final audit and checkpoint); an apply's Phase 0 checks
//                              both as declared, no default read.
//   upgrade.audit-mid-chunk    a corpus arc (holistic from the start) whose slug publication alone outgrows a lens's diff
//                              budget; the previous release's executor dies in the final audit's second chunk (its
//                              first chunk read). HEAD finds the same chunks, consumes the recorded first, asks the lost
//                              second again as a bounded diff (`<orientation>`), settles the checkpoint, completes the arc.
//
// The dev.16 variants (DEV16_RELEASE starts the arc, where there is one):
//   upgrade.dev16.result-earlier-reader
//                              no arc: an invocation dev.16's reader adapted (result.json written, its done not, as a
//                              crash leaves it) re-adapted on HEAD keeps the recorded result (`earlierReaderResultDefault`,
//                              dev.17), warned once.
//   upgrade.dev16.review-unledgered
//                              `page-id`'s gate revised and its fix round stopped mid-call; HEAD's gate rules on a prior
//                              round no findings ledger recorded (dev.17 proportional review: the answer and inputs read
//                              with their defaults, warned; an empty ledger, no disputes, a full review). HEAD runs
//                              page-id's lanes on revisions with no systems map and deflakes over no flaky ledger (both
//                              read with their defaults, warned).
//   upgrade.dev16.routing-stable
//                              as routing-stable, but HEAD's seat table (dev.17: frontier plan-check and gate at every
//                              tier, efficient builds) moved the rev: under the seats dev.16 hashed HEAD resolves the rev
//                              it recorded, under its own another; `page-id` re-pins without a park (its implementer seat
//                              unchanged) and its gate judges under HEAD's rev; `status` spend resolves every metered
//                              call (the dev.16 rev aliased, PRE_DEV17_BUILTIN_SEATS).
//   upgrade.dev16.plan-check-by-builder
//                              a corpus arc whose plan carries `planCheck.shape: by-builder` (removed in dev.17); stopped
//                              mid-build of `page-id`. HEAD reads the plan as uniform (warned, `planCheckShapeDefault`)
//                              and finishes the arc.
//   upgrade.dev16.spec-design-pins
//                              dev.16's setup lays out its specs (no arc runs): HEAD reads each with no design record
//                              (kind `module`, `designKindDefault`, warned) and no revision pins (every link `unpinned`: a
//                              lasting state, unwarned).
//   upgrade.dev16.design-pass-adopted
//                              dev.16's plan-check answers (its M1 fakes', as its arcs recorded them) read on HEAD with no
//                              design record (`planCheckDesignDefault`, warned); its role set (`m4b`) seats and hashes no
//                              scaffold role, so its revs do not move for it.
//
// The dev.11 variants (DEV11_RELEASE starts the arc):
//   upgrade.dev11.read-denied-retry
//                              dev.11's gate approves from a session refused a read, records `read-denied` and crashes
//                              before its retry (`unit.after-stage`); HEAD takes the retry by the old row (one uncharged
//                              retry), approves and merges.
//   upgrade.dev11.unpersisted-refused
//                              dev.11's gate answers off its schema in an unpersisted session and dev.11 crashes before
//                              reading it (`spawn.after-done`); HEAD reads the refusal with no repair turn (a call
//                              consumed after a crash takes none): `malformed`, then a fresh gate merges.
//   upgrade.dev11.audit-mid-chunk
//                              as audit-mid-chunk, dev.11's lens calls attaching the diff, not the bounded diff: HEAD
//                              finds the same chunks, and asks the lost second as a bounded diff.
//   upgrade.dev11.fingerprint-open-ff
//                              as fingerprint-open-ff, dev.11's gate recording no `diffShown` and no `largeDiff`: read as
//                              nothing shown and under the large-diff threshold (the dev.12 defaults).
//   upgrade.dev11.routing-stable
//                              as routing-stable, but HEAD's seat table (the gate risk ladder, 1.0.0-dev.12) moved the
//                              rev: under the seats dev.11 hashed HEAD resolves the rev it recorded, under its own
//                              another; `page-id` re-pins without a park and its gate judges under HEAD's rev; no
//                              `routing-changed`; `status` spend resolves every metered call (the dev.11 rev aliased).
//
// The dev.10 variants (DEV10_RELEASE starts the arc):
//   upgrade.dev10.apply-queued as apply-queued, the body `expectRev` with no `base` and no `visionEdit`: HEAD rebases
//                              it from the default base and applies it as plan revision 2, its bytes unchanged, the
//                              default warned.
//   upgrade.dev10.vision-edit-queued
//                              as opt-in-holistic, the opt-in apply queued through dev.10's CLI (no `visionEdit` field):
//                              adopted as a declared vision edit, never `vision-leak`; warned.
//   upgrade.dev10.reentry-before-fixes
//                              as reentry-with-fixes, the re-entry with no `fixes`: in force on HEAD, merged, never
//                              classified again; a later apply is accepted.
//   upgrade.dev10.written-back-inputs
//                              as inputs-in-force, but dev.10 writes the spec patch and C-3 back into the owner's spec,
//                              ledger and sidecar: HEAD's apply rebases those files cleanly as plan revision 3, C-3 in
//                              force and published once, and HEAD writes nothing into the owner's files.
//   upgrade.dev10.checkpoint-reentry-before-fixes
//                              as checkpoint-reentry-with-fixes, the bundle's re-entry with no `fixes` (and, on dev.10,
//                              the drift audit's own no-op checkpoint): HEAD's final checkpoint reads the applied answer
//                              with the default, warned; an apply then classifies as accepted.
//   upgrade.dev10.corpus-witnesses-undeclared
//                              as corpus-witnesses-declared, the arc lane without `testPaths` and the witness without
//                              `files`: an apply's Phase 0 reads both as undeclared, unchecked, each default warned.
//   upgrade.dev10.checkpoint-answer-unapplied
//                              as checkpoint-answer-unapplied, the recorded re-entry with no `fixes`: HEAD decides and
//                              applies it from the record (neither `fixes` row binds it), merges `page-id-2`; warned.
//
// Not covered: a backend parked on a usage limit, the Claude-only profile, an audit dev.10 started and left running
// (`audit-started.diffBudget`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { writeResult } from '../../src/backends/adapter.ts';
import { isAlive, statOf } from '../../src/contain/proc.ts';
import { readArcRef } from '../../src/chain.ts';
import { phase0Check } from '../../src/commands/phase0.ts';
import { verifySnapshot } from '../../src/git/snapshot.ts';
import type { Event, Fact } from '../../src/core/events.ts';
import { arcId, commandId, invocationId, obligationId, opId, resourceName, sha, unitId } from '../../src/core/ids.ts';
import { UNPINNED } from '../../src/core/pins.ts';
import type { JournalView } from '../../src/core/interfaces.ts';
import { type JsonValue, canonicalJson } from '../../src/core/json.ts';
import { gateDiffShownOf, gateLargeDiffOf } from '../../src/core/upgrade.ts';
import { type ProcIdentity, specKindOf, specPinOf } from '../../src/core/records.ts';
import { openJournal, readJournal } from '../../src/core/log.ts';
import { absPath, repoPath } from '../../src/core/values.ts';
import { incomingPath, terminalReceipt } from '../../src/commands/queue.ts';
import type { ExitReason } from '../../src/executor.ts';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { readOwner } from '../../src/host/owner.ts';
import { pressureAvailability } from '../../src/host/pressure.ts';
import { RESIDUE_ARCHIVE, bodyOf, readResidues, recordDisposition, recordResidue } from '../../src/host/residues.ts';
import { requirePlanInForce } from '../../src/input/inforce.ts';
import { overCapacity } from '../../src/resources/pool.ts';
import { bytesSha256, loadSpec } from '../../src/spec/spec.ts';
import { CONTINUE_DIRECTIVE } from '../../src/prompts/directives.ts';
import { meterOf } from '../../src/meter.ts';
import { arcStack, provenanceStack, resolveRouting, routingRevOf, seatsInForce } from '../../src/routing/layers.ts';
import { designOfAnswer, validatePlanCheckOutput } from '../../src/prompts/schemas.ts';
import { executorLogs, lastLine } from '../../src/supervisor.ts';
import { corpusTarget } from '../fixtures/corpus-target.ts';
import type { CheckResult } from '../../evals/m1/check.ts';
import type { Report } from '../../evals/m1/driver.ts';
import { type Layout, RESOURCE, UNITS, layout } from '../../evals/m1/layout.ts';
import { type M1Step, fakeSteps as headFakeSteps } from '../../evals/m1/scenario.ts';
import { type TriggerSpec, assertFired, writeTrigger } from '../helpers/crash.ts';
import { checkpointAnswer, checkpointStep, lensStep } from '../helpers/holistic.ts';
import { type Exit, fixture, runUntilExit } from '../helpers/proc.ts';
import { type RunScope, assertNoSurvivors, teardown, track } from '../helpers/reap.ts';
import { git, tmpDir } from '../helpers/repo.ts';
import { type CallRecord, type ClaudeAct, type ScenarioFile, type Step, readCalls, writeScenario } from '../helpers/scenario.ts';

after(assertNoSurvivors);

/** A released executor this test starts arcs on: its merge commit on main and the version its package.json names. */
type Release = Readonly<{ sha: string; version: string }>;

/**
 * The previous release: its executor starts the arc, HEAD's finishes it, in every cell not labelled with an older
 * release. At each release, move it to the last released commit, the merge of the previous release's PR into main.
 * Merges here are merge commits, so a merged branch's shas stay reachable and `git archive` finds them. Now:
 * 1.0.0-dev.21, merged to main as PR #125, merge commit 03a45d7 (schema version 1).
 */
const PREVIOUS_RELEASE: Release = { sha: '03a45d7000565ac49491a6b15d6062ecb78e6313', version: '1.0.0-dev.21' };
/** dev.20 snapshots and audit-only skips still have to be adopted after the issues integration was removed. */
const DEV20_RELEASE: Release = { sha: '6aea2bb5729a2c700a30cef65ff13f89a9838b5f', version: '1.0.0-dev.20' };
/**
 * 1.0.0-dev.16, merged to main as PR #119: no arc started on it is in flight, but the dev.17 defaults of
 * src/core/upgrade.ts it exercises (lane topology, the design pass, propagation, the flaky ledger, proportional review,
 * the earlier reader's result, PRE_DEV17_BUILTIN_SEATS, `planCheck.shape`) are read by the in-flight dev.11 and dev.10 arcs
 * too, so the cells labelled `upgrade.dev16.*` start their arc on it. Delete it, with those cells, when those defaults go
 * (BACKLOG "Scaffolding to delete").
 */
const DEV16_RELEASE: Release = { sha: 'bc04af770294487c6b3d9190c6c8de7669eff09e', version: '1.0.0-dev.16' };
/**
 * 1.0.0-dev.11, merged to main as PR #113: an arc started on it is in flight (adopted by dev.12, then by HEAD), so the
 * cells labelled `upgrade.dev11.*` start their arc on it and exercise the dev.11 defaults of src/core/upgrade.ts end to
 * end (gateDiffShownOf, gateLargeDiffOf, gateClustersDefault, gateUnreviewedDefault, PRE_DEV12_BUILTIN_SEATS, the
 * unpersisted judgment and `read-denied`). Delete it, with those cells, when those defaults go (BACKLOG "Scaffolding to
 * delete").
 */
const DEV11_RELEASE: Release = { sha: '1f7f69681fbf637126046dfc0c01617b1adfdb17', version: '1.0.0-dev.11' };
/**
 * 1.0.0-dev.10, merged to main as PR #112: an arc started on it is in flight (adopted by dev.11 and dev.12, then by
 * HEAD), so the cells labelled `upgrade.dev10.*` start their arc on it and exercise the dev.10 defaults of
 * src/core/upgrade.ts end to end. Delete it, with those cells, when those defaults go (BACKLOG "Scaffolding to delete").
 * Arcs started on dev.7 to dev.9 stay adopted through their defaults too, but no arc of theirs is in flight and this
 * test starts none.
 */
const DEV10_RELEASE: Release = { sha: 'b1c3666843fa458c46eb2e541c97f62dd0244328', version: '1.0.0-dev.10' };
const RELEASES: readonly Release[] = [PREVIOUS_RELEASE, DEV20_RELEASE, DEV16_RELEASE, DEV11_RELEASE, DEV10_RELEASE];
/**
 * The releases before 1.0.0-dev.17: their lanes declare `tier`, not `cadence`, and their strict judgment schemas refuse
 * dev.17's answer fields (plan-check `staleLinks`; gate `rulings`, a finding's `defect`, `reraises` and `hunk`).
 */
const BEFORE_DEV17: ReadonlySet<Release> = new Set([DEV16_RELEASE, DEV11_RELEASE, DEV10_RELEASE]);
/**
 * The releases before 1.0.0-dev.12: their judgments ran with `--tools Read,Grep,Glob` (no Agent tool), and their strict
 * gate schema refuses `unreviewed` and `clusters`.
 */
const BEFORE_DEV12: ReadonlySet<Release> = new Set([DEV11_RELEASE, DEV10_RELEASE]);
/**
 * The `--tools` value `release`'s plan-check runs with: from 1.0.0-dev.17 an acting judge's (the design pass, with the
 * web tools; evals/m1/scenario.ts), before it a read-only judge's, before 1.0.0-dev.12 without the Agent tool.
 */
const planCheckToolsOf = (release: Release): string =>
  BEFORE_DEV12.has(release) ? 'Read,Grep,Glob' : BEFORE_DEV17.has(release) ? 'Read,Grep,Glob,Agent' : 'Read,Grep,Glob,Bash,Write,Edit,Agent,WebSearch,WebFetch';
/** The `--tools` value the gate of `release`, a release before 1.0.0-dev.17 (`releaseGate`), runs with. */
const judgmentToolsOf = (release: Release): string => {
  assert.ok(BEFORE_DEV17.has(release), `${release.version}'s gate acts: its tools are evals/m1/scenario.ts's`);
  return BEFORE_DEV12.has(release) ? 'Read,Grep,Glob' : 'Read,Grep,Glob,Agent';
};
const EXECUTOR_PATH = 'plugins/roadmap-orchestrator/executor';

const EXECUTOR = fileURLToPath(new URL('../../', import.meta.url));
const EVALS = join(EXECUTOR, 'evals', 'm1');
/** The driver's own hard timeout under --fake is 5 min; each phase gets that and a margin. */
const PHASE_MS = 7 * 60_000;
const T = { timeout: 3 * PHASE_MS };
/** How long a test whose premise is a calm host waits for the host to clear (park-adopted), and its timeout. */
const CLEAR_HOST_MS = 20 * 60_000;
const T_CALM = { timeout: 3 * PHASE_MS + CLEAR_HOST_MS };
const CLI_MS = 60_000;
/** `start` waits for readiness itself (240 s by default). */
const START_MS = 300_000;
const POLL_MS = 200;

type PreviousModules = Readonly<{
  fakeSteps: typeof import('../../evals/m1/scenario.ts').fakeSteps;
  readScenario: typeof import('../../evals/m1/scenario.ts').readScenario;
  writeShims: typeof import('../fakes/shim.ts').writeShims;
  /** The release's host sample and its busy/clear thresholds (the host park's classification). */
  sample: Readonly<{
    readHostSample: typeof import('../../src/host/sample.ts').readHostSample;
    isBusy: (s: ReturnType<typeof import('../../src/host/sample.ts').readHostSample>) => boolean;
    isClear: (s: ReturnType<typeof import('../../src/host/sample.ts').readHostSample>) => boolean;
  }>;
}>;
/** A release's executor tree, extracted, and the modules the harness uses from it. */
type Previous = Readonly<{ root: string; modules: PreviousModules }>;
/** A release's holistic test helpers and obligation types, loaded from its tree where a cell builds its steps or lanes. */
type PreviousHelpers = typeof import('../helpers/holistic.ts');
type PreviousTypes = typeof import('../../src/holistic/types.ts');

const extracted = new Map<Release, Previous>();

/** The extracted tree of `release` (one of RELEASES). */
function previousOf(release: Release): Previous {
  const got = extracted.get(release);
  assert.ok(got !== undefined, `release ${release.version} is not in RELEASES`);
  return got;
}

/** Imports a module of `release`'s extracted tree. */
const loadFrom = <M>(release: Release, ...path: string[]): Promise<M> => import(pathToFileURL(join(previousOf(release).root, ...path)).href) as Promise<M>;

/** Each release's executor tree, extracted into a temp dir, and the modules the harness uses from it. */
before(async () => {
  const top = spawnSync('git', ['-C', EXECUTOR, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  assert.equal(top.status, 0, top.stderr);
  for (const release of RELEASES) {
    const archive = spawnSync('git', ['-C', top.stdout.trim(), 'archive', '--format=tar', release.sha, EXECUTOR_PATH], { maxBuffer: 1 << 30 });
    assert.equal(archive.status, 0, `git archive ${release.sha}: ${archive.stderr}`);
    const dir = tmpDir('upgrade-previous');
    const tar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
    assert.equal(tar.status, 0, `tar: ${tar.stderr}`);
    const root = join(dir, EXECUTOR_PATH);
    assert.equal((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version, release.version);
    const load = (path: string): Promise<Record<string, unknown>> => import(pathToFileURL(join(root, path)).href);
    const [scenario, shim, sample] = await Promise.all([load('evals/m1/scenario.ts'), load('test/fakes/shim.ts'), load('src/host/sample.ts')]);
    extracted.set(release, {
      root,
      modules: {
        fakeSteps: scenario['fakeSteps'], readScenario: scenario['readScenario'], writeShims: shim['writeShims'],
        sample: { readHostSample: sample['readHostSample'], isBusy: sample['isBusy'], isClear: sample['isClear'] },
      } as PreviousModules,
    });
  }
});

// A real older ref must be verified before any HEAD publication can replace its closure. In particular, dev.20
// kept phase0Issues bytes even though today's executor no longer uses the issues integration.
for (const release of [DEV20_RELEASE, PREVIOUS_RELEASE]) {
  test(`upgrade.snapshot-${release.version}: an untouched released corpus snapshot verifies, adopts and passes Phase 0 on HEAD`, T, async () => {
    const old = await loadFrom<typeof import('../helpers/corpusarc.ts')>(release, 'test/helpers/corpusarc.ts');
    const verifier = await loadFrom<typeof import('../../src/git/snapshot.ts')>(release, 'src/git/snapshot.ts');
    const oldInputs = release === DEV20_RELEASE ? await loadFrom<typeof import('../../src/input/inforce.ts')>(release, 'src/input/inforce.ts') : null;
    const a = await old.corpusArc();
    await old.seal(a, { complete: false, before: (j) => {
      if (release !== DEV20_RELEASE) return;
      // A later checkpoint's capture differs from the initial Phase-0 capture and is named only by this fact.
      const capture = j.view.nextJobId('ckpt');
      const bytes = Buffer.from('{"legacyCheckpointCapture":true}\n');
      const digest = oldInputs!.keepInput(old.runDirOfArc(a), bytes, 'issues.json');
      j.fact({ kind: 'issues-captured', job: capture, sha256: digest, repo: { host: 'github.com', owner: 'o', name: 'n' },
        filtered: { comments: 0, pullRequests: 0 } } as Fact);
    } });
    const commit = sha(git(a.repo, 'rev-parse', `refs/roadmap/${a.arc}`));
    const released = verifier.verifySnapshot(a.repo, commit);
    assert.equal(released.kind, 'verified');
    if (release === DEV20_RELEASE && released.kind === 'verified') {
      assert.equal(released.manifest.files.filter((f) => f.path.endsWith('.issues.json')).length, 2, 'exercise the dev.20 capture that dev.21 omitted from its closure');
    }
    const check = verifySnapshot(a.repo, commit);
    assert.equal(check.kind, 'verified', check.kind === 'mismatch' ? check.detail : '');
    assert.equal(readArcRef(a.repo, a.arc)!.commit, commit);
    const report = await phase0Check({ repo: a.repo, source: { type: 'ref', arc: a.arc } });
    assert.deepEqual(report.rows, []);
  });
}

// dev.21 left a dev.20 arc's issues captures out of the snapshots it published; dev.22 required them again, so HEAD
// must still verify (and chain from) the ref dev.21 left.
test(`upgrade.snapshot-dev21-of-dev20: a ref ${PREVIOUS_RELEASE.version} published for a ${DEV20_RELEASE.version} arc with issues captures verifies, adopts and passes Phase 0 on HEAD`, T, async () => {
  const started = await loadFrom<typeof import('../helpers/corpusarc.ts')>(DEV20_RELEASE, 'test/helpers/corpusarc.ts');
  const adopted = await loadFrom<typeof import('../helpers/corpusarc.ts')>(PREVIOUS_RELEASE, 'test/helpers/corpusarc.ts');
  const oldInputs = await loadFrom<typeof import('../../src/input/inforce.ts')>(DEV20_RELEASE, 'src/input/inforce.ts');
  const a = await started.corpusArc();
  await started.seal(a, { complete: false, before: (j) => {
    const digest = oldInputs.keepInput(started.runDirOfArc(a), Buffer.from('{"legacyCheckpointCapture":true}\n'), 'issues.json');
    j.fact({ kind: 'issues-captured', job: j.view.nextJobId('ckpt'), sha256: digest, repo: { host: 'github.com', owner: 'o', name: 'n' },
      filtered: { comments: 0, pullRequests: 0 } } as Fact);
  } });
  // dev.21 completes the arc: its seal commits its own work again, so move the file off that content first.
  writeFileSync(join(a.repo, 'src', `${a.arc}.ts`), 'interim\n');
  git(a.repo, 'commit', '--quiet', '--all', '-m', 'interim');
  await adopted.seal(a);
  const commit = sha(git(a.repo, 'rev-parse', `refs/roadmap/${a.arc}`));
  const tree = git(a.repo, 'ls-tree', '-r', '--name-only', commit);
  assert.doesNotMatch(tree, /\.issues\.json$/m, 'exercise the ref dev.21 published without the issues captures');
  const check = verifySnapshot(a.repo, commit);
  assert.equal(check.kind, 'verified', check.kind === 'mismatch' ? check.detail : '');
  assert.equal(readArcRef(a.repo, a.arc)!.commit, commit);
  const report = await phase0Check({ repo: a.repo, source: { type: 'ref', arc: a.arc } });
  assert.deepEqual(report.rows, []);
});

// ---------------------------------------------------------------------------------------------------
// Scenario pieces (evals/m1/scenarios/clean.json, whose steps are slug's three then page-id's three)

type Clean = Readonly<{ slug: readonly M1Step[]; pageId: Readonly<{ planCheck: M1Step; build: Extract<M1Step, { role: 'build' }>; gate: M1Step }> }>;

function clean(): Clean {
  const steps = (JSON.parse(readFileSync(join(EVALS, 'scenarios', 'clean.json'), 'utf8')) as { steps: M1Step[] }).steps;
  const [pc1, b1, g1, planCheck, build, gate] = steps;
  assert.ok(pc1 && b1 && g1 && planCheck && build && gate && build.role === 'build' && steps.length === 6);
  return { slug: [pc1, b1, g1], pageId: { planCheck, build, gate } };
}

/** `page-id`'s build files (clean.json). */
function pageIdFiles(c: Clean): Readonly<Record<string, string>> {
  const files = c.pageId.build.acts.flatMap((a) => (a.type === 'commit' ? [a.files] : []))[0];
  assert.ok(files !== undefined);
  return files as Readonly<Record<string, string>>;
}

const ESCALATE: M1Step = {
  role: 'planCheck',
  answer: { decision: 'escalate', reasons: ['The contract is ambiguous.'], patch: null, risk: 'med', notes: '', premises: [], visionConflict: [], scopeGrowth: [], staleLinks: [] },
};

/** Where the previous release is stopped: a fake call parked at a barrier in its scenario dir. */
const MID_CALL = 'mid-call';
const MID_BUILD_THREAD = '11111111-1111-4111-8111-111111111111';
/** page-id's fresh build: its Codex thread started, its files written but not committed, then parked. */
const midBuild = (files: Readonly<Record<string, string>>): Step => ({
  as: 'codex', threadId: MID_BUILD_THREAD, expect: { argv: ['exec', '-C'] },
  acts: [{ type: 'threadStarted' }, { type: 'dirty', files }, { type: 'barrier', name: MID_CALL, timeoutMs: PHASE_MS }],
});
/** page-id's plan-check after its reopen, parked (`release`'s plan-check tools). */
const midPlanCheck = (release: Release): Step => ({
  as: 'claude', expect: { argv: ['-p', '--tools', planCheckToolsOf(release)] }, acts: [{ type: 'barrier', name: MID_CALL, timeoutMs: PHASE_MS }],
});

// ---------------------------------------------------------------------------------------------------
// Phase 1: the previous release

type Phase1 = Readonly<{
  /** The release that started the arc, and its extracted tree. */
  release: Release;
  prev: Previous;
  dir: string;
  l: Layout;
  host: string;
  fakeDir: string;
  /** The starting release's `roadmap` CLI against the fixture's host dir, its fakes first on PATH. */
  cli: (args: readonly string[], timeoutMs?: number, env?: Readonly<Record<string, string>>) => Promise<Exit>;
  run: readonly string[];
}>;

/**
 * A step as `release` gives it: dev.20 gives HEAD's plan-check and gate answers. Before 1.0.0-dev.17, a plan-check
 * answer without `staleLinks` (propagation) and a gate answer without `rulings` and its findings' `defect`, `reraises` and
 * `hunk` (proportional review); before 1.0.0-dev.12, a gate answer also without `unreviewed` (round 2) or `clusters` (the
 * large-diff gate). Each release's strict schemas refuse the fields they do not know (HEAD's scenarios carry them for HEAD's
 * judgments). Every other step is unchanged.
 */
function asReleaseGate(release: Release, step: M1Step): M1Step {
  if (!BEFORE_DEV17.has(release)) return step;
  if (step.role === 'planCheck') {
    const { staleLinks: _s, ...answer } = step.answer as Readonly<Record<string, JsonValue>>;
    return { ...step, answer };
  }
  if (step.role !== 'gate') return step;
  const { rulings: _r, findings, ...rest } = step.answer as Readonly<Record<string, JsonValue>>;
  const dev16 = (findings as readonly Readonly<Record<string, JsonValue>>[]).map(({ defect: _d, reraises: _x, hunk: _h, ...f }) => f);
  const answer: Readonly<Record<string, JsonValue>> = { ...rest, findings: dev16 };
  if (!BEFORE_DEV12.has(release)) return { ...step, answer };
  const { unreviewed: _u, clusters: _c, ...dev11 } = answer;
  return { ...step, answer: dev11 };
}

/**
 * Lays out the fixture with `release`'s setup (the previous release by default), lets `edit` change its inputs before
 * anything runs, and writes the fakes for `m1` (or what it makes of the laid-out fixture) then `extra` (raw fake steps).
 */
async function preparePrevious(
  m1: readonly M1Step[] | ((l: Layout) => readonly M1Step[]), extra: readonly Step[], edit: (l: Layout) => void = () => {}, release: Release = PREVIOUS_RELEASE,
): Promise<Phase1> {
  const prev = previousOf(release);
  const dir = join(tmpDir('upgrade'), 'fx');
  const setup = await runUntilExit(process.execPath, [join(prev.root, 'evals', 'm1', 'setup.ts'), dir], { env: process.env, timeoutMs: CLI_MS });
  assert.equal(setup.code, 0, setup.stderr);
  const l = layout(dir);
  const planArc = (JSON.parse(readFileSync(l.plan, 'utf8')) as { arc: string }).arc;
  assert.equal(planArc, l.arc, 'the previous release lays the fixture out as HEAD\'s evals/m1/layout.ts does; if not, adapt this harness');
  edit(l);
  // HEAD's driver finishes the run with the host dir under fake/, so the previous release starts it there too.
  const host = join(l.fake, 'host');
  mkdirSync(host, { recursive: true });
  const fakeDir = join(dir, 'fake-previous');
  mkdirSync(fakeDir, { recursive: true });
  const m1File = join(fakeDir, 'm1.json');
  writeFileSync(m1File, JSON.stringify({ steps: (typeof m1 === 'function' ? m1(l) : m1).map((step) => asReleaseGate(release, step)) }));
  const { fakeSteps, readScenario, writeShims } = prev.modules;
  const scenario = join(fakeDir, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ steps: [...fakeSteps(readScenario(m1File), 'default'), ...extra] }, null, 2));
  writeShims(join(fakeDir, 'bin'), scenario);
  const env = { ...process.env, PATH: `${join(fakeDir, 'bin')}:${process.env['PATH'] ?? ''}` };
  const cli = (args: readonly string[], timeoutMs = CLI_MS, extraEnv: Readonly<Record<string, string>> = {}): Promise<Exit> =>
    runUntilExit(process.execPath, [join(prev.root, 'test', 'fixtures', 'exec-cli.ts'), host, ...args], { env: { ...env, ...extraEnv }, timeoutMs });
  return { release, prev, dir, l, host, fakeDir, cli, run: ['--repo', l.repo, '--arc', l.arc] };
}

/** HEAD's `roadmap` CLI against the fixture's host dir. */
const headCli = (p: Phase1, args: readonly string[]): Promise<Exit> =>
  runUntilExit(process.execPath, [fixture('exec-cli.ts'), p.host, ...args], { env: process.env, timeoutMs: CLI_MS });

/** The run's processes, stopped through HEAD's CLI when a test fails midway. */
function scopeOf(p: Phase1): RunScope {
  return {
    paths: [p.dir],
    stop: async () => {
      const stop = await headCli(p, ['stop', ...p.run]);
      assert.equal(stop.code, 0, `roadmap stop: ${stop.stderr}`);
    },
  };
}

const journalOf = (p: Phase1) => readJournal(absPath(p.l.runDir), arcId(p.l.arc));

async function until<T>(what: string, timeoutMs: number, probe: () => T | null): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = probe();
    if (got !== null) return got;
    if (Date.now() >= deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await sleep(POLL_MS);
  }
}

/** Starts the previous release's run (`env` added to its start, and so to its supervisor and executors); returns its supervisor. */
async function startPrevious(p: Phase1, env: Readonly<Record<string, string>> = {}): Promise<ProcIdentity> {
  const start = await p.cli(['start', '--repo', p.l.repo, '--plan', p.l.plan, '--profile', 'default'], START_MS, env);
  assert.equal(start.code, 0, `previous release start: ${start.stdout} ${start.stderr}`);
  const ready = JSON.parse(start.stdout) as { kind: string; generation: number; supervisor: number };
  assert.equal(ready.kind, 'ready', start.stdout);
  const stat = statOf(ready.supervisor);
  assert.ok(stat !== null, 'the supervisor is alive after start');
  return { pid: ready.supervisor, start: stat.start };
}

/** Waits until the fake call of MID_CALL is parked at its barrier. */
const midCall = (p: Phase1): Promise<true> => until(`the ${MID_CALL} barrier is reached`, PHASE_MS, () => (existsSync(join(p.fakeDir, `${MID_CALL}.reached`)) ? true : null));

/** `roadmap stop` through the previous release's CLI, then waits for its supervisor (and so its executor) to exit. */
async function stopPrevious(p: Phase1, supervisor: ProcIdentity): Promise<void> {
  const stop = await p.cli(['stop', ...p.run]);
  assert.equal(stop.code, 0, stop.stderr);
  await until('the previous release\'s supervisor exits after stop', 60_000, () => (isAlive(supervisor) ? null : true));
}

/**
 * Runs the previous release until its executor crashes at `spec` (it SIGKILLs itself there), and leaves what the crash
 * left open for HEAD: the supervisor is frozen as soon as it is ready, so no generation of the previous release
 * respawns to recover it, and SIGKILLed once the executor is gone. `act` runs meanwhile (the architect's commands);
 * `env` is added to the start.
 */
async function crashPrevious(p: Phase1, spec: TriggerSpec, act: () => Promise<void> = async () => {}, env: Readonly<Record<string, string>> = {}): Promise<void> {
  const trigger = writeTrigger(p.dir, spec);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p, { ...env, ROADMAP_TEST_CRASH: trigger });
    process.kill(supervisor.pid, 'SIGSTOP');
    await act();
    await until(`the previous release's executor crashes at ${spec.label}`, PHASE_MS, () => (existsSync(`${trigger}.fired`) ? true : null));
    const executor = readOwner(absPath(p.host))?.executor ?? null;
    assert.ok(executor !== null, 'host.owner.json names the crashed executor');
    await until('the crashed executor is gone', 60_000, () => (isAlive(executor) ? null : true));
    process.kill(supervisor.pid, 'SIGKILL');
    await until('the frozen supervisor is gone', 60_000, () => (isAlive(supervisor) ? null : true));
  } finally {
    await teardown(scope);
  }
  assertFired(trigger);
  const started = journalOf(p).events.filter((e) => e.type === 'fact' && e.fact.kind === 'executor-started');
  assert.equal(started.length, 1, 'one executor generation of the previous release ran: nothing of it recovered the crash');
}

// ---------------------------------------------------------------------------------------------------
// Phase 2: HEAD finishes the arc

type Finished = Readonly<{
  driver: Exit; report: Report; check: CheckResult; calls: readonly CallRecord[]; events: readonly Event[]; after: readonly Event[]; view: JournalView;
}>;

/**
 * HEAD's driver on the same fixture with `m1` (its smoke prepended), then HEAD's check. `during` runs alongside the
 * driver (the architect acting on the running arc).
 */
async function finishOnHead(p: Phase1, m1: readonly M1Step[], during: () => Promise<void> = async () => {}): Promise<Finished> {
  const highWater = journalOf(p).view.highWater();
  const file = join(p.dir, 'head.json');
  writeFileSync(file, JSON.stringify({ steps: m1 }));
  const [driver] = await Promise.all([
    runUntilExit(process.execPath, [join(EVALS, 'driver.ts'), p.dir, '--profile', 'default', '--fake', file], { env: process.env, timeoutMs: PHASE_MS }),
    during(),
  ]);
  const report = JSON.parse(readFileSync(p.l.report, 'utf8')) as Report;
  const checked = await runUntilExit(process.execPath, [join(EVALS, 'check.ts'), p.dir], { env: process.env, timeoutMs: CLI_MS });
  const check = JSON.parse(checked.stdout.split('\n')[0]!) as CheckResult;
  const scenario = join(p.l.fake, 'scenario.json');
  const calls = readCalls(scenario);
  const steps = (JSON.parse(readFileSync(scenario, 'utf8')) as ScenarioFile).steps;
  assert.deepEqual(calls.map((c) => c.step), steps.map((_, i) => i), 'HEAD\'s calls matched every step of its scenario, in order');
  const { view, events } = journalOf(p);
  assertNoDefaultRead(p);
  return { driver, report, check, calls, events, after: events.filter((e) => e.seq > highWater), view };
}

/**
 * The defaults HEAD reads an arc dev.16 started with (1.0.0-dev.17, lane topology): its lanes' `tier` as a
 * cadence (`lane.tier.<kind>`), a recorded lane rev of the tier form (`lane-rev.tier.<lane>`), its revisions' absent
 * systems map (`plan-applied.systemsMap`), its specs' absent design record (`spec.design.kind`), (propagation) its
 * plan-check answers' absent `staleLinks` (`plan-check.staleLinks`), (the design pass) its plan-check answers' absent design
 * record (`plan-check.design`, read back for the build's notes), its absent flaky ledger (`flaky.ledger`: empty at the
 * upgrade); and (proportional review) its gate answers without `defect`, `reraises`, `hunk` and `rulings`
 * (`gate.finding.review`, `gate.rulings`), its gate inputs without a review (`judgment-inputs.review`), its build answers
 * without `docsOnlySince` (`build.docsOnlySince`) and its approvals without blobs (`approval.blobs.<unit>`). A spec's
 * absent pins are no default (a lasting state: every link unpinned).
 */
const DEV17_DEFAULTS = /^(lane\.tier\.(spec|suite|arc)|lane-rev\.tier\..+|plan-applied\.systemsMap|spec\.design\.kind|plan-check\.staleLinks|plan-check\.design|flaky\.ledger|gate\.finding\.review|gate\.rulings|judgment-inputs\.review|build\.docsOnlySince|approval\.blobs\..+)$/;

/**
 * The lasting read a dev.20 arc warns for: `spec.design.kind`, a spec no approving plan-check has designed yet
 * (kind `module`), read so on dev.20 and HEAD alike. No fixture records flakes, so `flake-observed.on` is not allowed;
 * summit-effort routing aliases emit no default warning. Legacy checkpoint skips are expected only by their cell.
 */
const DEV20_LASTING = /^spec\.design\.kind$/;

// Calibrated resources do not infer execution keys or reservation bases for earlier launches.
const RESOURCE_DEFAULTS = /^(proc\.spawn\.cpuKey|resource\.transition\.cpuBasis|environment\.resources|sched\.pressureBlocked)$/;

/**
 * dev.21 removed the GitHub issues integration: what an arc started before it holds for issues (its Phase-0 record's
 * capture and intake, its manifests' `phase0Issues`, its checkpoints' captures, intake and recorded `issueIntake`) is read
 * as written and ignored, warned (`issuesIgnored`, src/core/upgrade.ts): expected of every earlier release's arc.
 */
const ISSUES_IGNORED = /^issues\.(issue-intake|issues-captured|checkpoint-inputs\.issues|plan-changed\.phase0\.issuesSha256|manifest\.phase0Issues|phase0\.(issueCapture|intake)|checkpoint\.issueIntake|corpus-amendment\.source\.issue)$/;

/**
 * Once HEAD's phase ends, every `roadmap: upgrade default` an executor of the host dir warned is one HEAD reads the
 * starting release's arc with, or a kind the cell's story reads on purpose (`expected`, e.g. dev.16's
 * `plan.planCheck.shape`, a plan field dev.17 removed). An arc dev.20 started: `DEV20_LASTING` and the exact
 * `ISSUES_IGNORED` kinds; dev20.checkpoint-reentry-with-fixes alone also expects `checkpoint-skipped.trigger`. An arc dev.16
 * started: the dev.17 defaults (`DEV17_DEFAULTS`) and `ISSUES_IGNORED`, its spec lanes' tier read as their cadence among them (the
 * absent systems map is warned only where HEAD reads the map in force, a lane's selection or reuse; asserted in
 * `upgrade.dev16.review-unledgered`, which runs lanes on HEAD). An older release's cells assert the defaults they read
 * instead.
 */
function assertNoDefaultRead(p: Phase1, expected: readonly string[] = []): void {
  if (p.release !== PREVIOUS_RELEASE && p.release !== DEV20_RELEASE && p.release !== DEV16_RELEASE) return;
  const allowed = p.release === DEV16_RELEASE ? DEV17_DEFAULTS : DEV20_LASTING;
  const kinds = [...hostLogs(p).matchAll(/roadmap: upgrade default \(([^)]+)\)/g)].map((m) => m[1]!);
  for (const kind of kinds) {
    if (!expected.includes(kind) && !ISSUES_IGNORED.test(kind) && !RESOURCE_DEFAULTS.test(kind)) assert.match(kind, allowed, `HEAD read the ${p.release.version} arc with the ${kind} default`);
  }
  if (p.release === DEV16_RELEASE) assert.ok(kinds.includes('lane.tier.spec'), `HEAD read the ${p.release.version} spec lanes' tier as their cadence, and warned`);
}

/** Every check.ts criterion passes, both units merged, one HEAD generation ran it, and the upgrade forced no park. */
function assertFinished(f: Finished): void {
  assert.equal(f.driver.code, 0, `driver: ${f.driver.stdout} ${f.driver.stderr}`);
  assert.equal(f.report.endedBy, 'exit');
  assert.equal(f.report.generation, f.report.start.ready?.generation, 'HEAD\'s executor was not restarted');
  assert.ok((f.report.generation ?? 0) > 1, 'HEAD ran a later host generation than the previous release');
  assert.deepEqual(f.report.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  assert.deepEqual(f.check.criteria.filter((c) => !c.pass), [], JSON.stringify(f.check.criteria));
  assert.equal(f.check.criteria.length, 8);
  const forced = f.after.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && ['park', 'stop'].includes(e.fact.class) ? [`${e.fact.unit} ${e.fact.stage} ${e.fact.outcome}`] : []));
  assert.deepEqual(forced, [], 'the upgrade parked or stopped no unit');
  const raised = f.after.flatMap((e) => (e.type === 'intent' && e.kind === 'needsuser.raise' ? [e.expect.id] : []));
  assert.deepEqual(raised, [], 'HEAD raised no needs-user');
  assertDag(f);
  assertPressure(f);
}

/**
 * M4b rev 3: both releases record host pressure. Every start, the previous release's and HEAD's, records this host's
 * schedstat availability, and every spawn either closed records its pressure (a number, or null for a launch under
 * `PRESSURE_MIN_WALL_MS`; null always without schedstat).
 */
function assertPressure(f: Finished): void {
  const available = pressureAvailability();
  const headFirst = f.after[0]?.seq ?? Infinity;
  assert.ok(factsOf(f.events.filter((e) => e.seq < headFirst), 'executor-started').length > 0, 'the previous release started the arc');
  for (const s of factsOf(f.events, 'executor-started')) assert.equal(s.pressure, available, JSON.stringify(s));
  const spawnResults = (events: readonly Event[]) => events.flatMap((e) => (e.type === 'done' && e.kind === 'proc.spawn' && e.outcome.kind === 'result' ? [e.outcome] : []));
  assert.ok(spawnResults(f.after).length > 0, 'HEAD closed spawns');
  for (const outcome of spawnResults(f.events)) {
    assert.notEqual(outcome.pressure, undefined, JSON.stringify(outcome));
    if (available === 'unavailable') assert.equal(outcome.pressure, null, JSON.stringify(outcome));
  }
}

/**
 * The previous release's arc is a DAG arc under HEAD too: `scheduling: dag`, and HEAD reserves `@cpu` tokens for the
 * stages it runs (an ff and a snapshot reserve none).
 */
function assertDag(f: Finished): void {
  assert.equal(factsOf(f.events, 'plan-applied')[0]?.scheduling, 'dag');
  const ran = factsOf(f.after, 'stage-outcome').filter((o) => o.stage !== 'ff' && o.stage !== 'snapshot');
  const cpu = f.after.flatMap((e) => (e.type === 'intent' && e.kind === 'resource.transition' ? e.expect.resources.filter((r) => r.startsWith('@cpu#')) : []));
  assert.equal(cpu.length > 0, ran.length > 0, `HEAD reserved @cpu exactly when it ran a stage that takes it: ${JSON.stringify(ran.map((o) => o.stage))}`);
}

/** HEAD's calls after its start-up smoke (Claude, then Codex, under `default`). */
const SMOKE_CALLS = 2;

const factsOf = <K extends Fact['kind']>(events: readonly Event[], kind: K): readonly Extract<Fact, { kind: K }>[] =>
  events.flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [e.fact as Extract<Fact, { kind: K }>] : []));
/** The stage outcomes of `unit` among `events`, as `stage:outcome`. */
const outcomesOf = (events: readonly Event[], unit: string): readonly string[] =>
  factsOf(events, 'stage-outcome').filter((f) => f.unit === unit).map((f) => `${f.stage}:${f.outcome}`);

// ---------------------------------------------------------------------------------------------------

/**
 * Phase 1 of stop-mid-build: the previous release (or `release`) merges `slug` and is stopped mid-build of `page-id` (held,
 * interrupted); `resume` is queued through its CLI unless `queueResume` is false (the caller releases it later).
 * Returns the phase and HEAD's steps to finish it (the build resumed with the continue directive, then the gate).
 */
async function stoppedMidBuild(
  c: Clean, edit?: (l: Layout) => void, queueResume = true, extra: readonly Step[] = [], release: Release = PREVIOUS_RELEASE,
): Promise<Readonly<{ p: Phase1; head: readonly M1Step[] }>> {
  const p = await preparePrevious([...c.slug, c.pageId.planCheck], [midBuild(pageIdFiles(c)), ...extra], edit, release);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await midCall(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const held = mid.unit(unitId('page-id'));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['build', 'held', 'interrupted']);
  if (queueResume) {
    const resume = await p.cli(['resume', ...p.run]);
    assert.equal(resume.code, 0, resume.stderr);
  }
  return { p, head: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] };
}

test('upgrade.stop-mid-build: HEAD continues the Codex thread the previous release was stopped in, and merges the arc', T, async () => {
  const { p, head } = await stoppedMidBuild(clean());
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const builds = f.calls.slice(SMOKE_CALLS).filter((call) => call.as === 'codex');
  assert.deepEqual(builds.map((b) => b.argv.slice(0, 3)), [['exec', 'resume', MID_BUILD_THREAD]], 'HEAD resumed the thread the previous release started, and started no fresh session');
  const gated = factsOf(f.after, 'judgment-inputs').filter((i) => i.stage === 'gate');
  assert.ok(gated.length === 1 && gated[0]!.diffShown !== undefined && gated[0]!.diffShown.inlined.length > 0, 'HEAD\'s gate records what its bounded diff showed');
  assert.equal(gated[0]!.largeDiff, null, 'HEAD\'s gate records its diff under the large-diff threshold');
  // The previous release's revisions record a systems map and its arc keeps a flaky ledger: HEAD reads both as recorded
  // (no default, `assertNoDefaultRead`), and with no flake since, its deflake job mints nothing.
  assert.deepEqual(factsOf(f.after, 'flake-observed'), []);
  assert.deepEqual(factsOf(f.after, 'plan-applied').filter((x) => x.source.type === 'deflake'), [], 'no deflake unit');
});

test('upgrade.reopen-mid-plan-check: a unit the previous release parked, re-opened and stopped mid-judgment finishes on HEAD', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, ESCALATE, ESCALATE], [midPlanCheck(PREVIOUS_RELEASE)]);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await parkedAtPlanCheck(p);
    // The architect's edit: the next rev, one more fact, put in force by `roadmap apply` (a pending revision);
    // then `resume page-id` re-opens the unit on it.
    const apply = await p.cli(['apply', ...p.run]);
    assert.equal(apply.code, 0, apply.stderr);
    await until('the previous release applies the revision as plan revision 2', PHASE_MS, () => (journalOf(p).view.planApplied()?.rev === 2 ? true : null));
    const reopen = await p.cli(['resume', 'page-id', ...p.run]);
    assert.equal(reopen.code, 0, reopen.stderr);
    await midCall(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const held = mid.unit(unitId('page-id'));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome, held.reopened?.specRev], ['plan-check', 'held', 'interrupted', 2]);
  assert.deepEqual(mid.needsUser().map((n) => [n.blocking, n.ack !== null]), [[true, true]], 'the park\'s needs-user, acknowledged by the reopen');
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [c.pageId.planCheck, c.pageId.build, c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const u = f.view.unit(unitId('page-id'));
  // Re-opened on rev 2; HEAD's approving plan-check lands its design record as the spec's next revision (dev.17, the design pass).
  assert.deepEqual([u.reopened?.specRev, u.spec?.rev], [2, 3], 'page-id re-opened on the previous release\'s rev 2, merged on its designed rev 3');
  await assertAcceptsApply(p, f);
});

/**
 * Waits until the previous release parks `page-id` at plan-check on a raised needs-user, then writes the architect's
 * edit of its spec: the next rev, one more fact (put in force by the caller's `roadmap apply`).
 */
async function parkedAtPlanCheck(p: Phase1): Promise<void> {
  await until('page-id parks on a raised needs-user', PHASE_MS, () => {
    const view = journalOf(p).view;
    return view.unit(unitId('page-id')).status === 'park-pending' && view.needsUser().length > 0 ? true : null;
  });
  const specPath = join(p.l.input, 'page-id.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { rev: number; facts: object[] };
  writeFileSync(specPath, `${JSON.stringify({ ...spec, rev: spec.rev + 1, facts: [...spec.facts, { id: 'F2', text: 'Contract one is unambiguous about the empty slug.', state: 'active' }] }, null, 2)}\n`);
}

/**
 * The previous release kept the plan revisions (1 at its start, 2 by its apply): HEAD's start finds its files
 * in force and records none, and the arc then takes `roadmap apply` like any other: a unit added to its plan
 * classifies as accepted (a dry run: the arc is complete, and no executor runs to apply it).
 */
async function assertAcceptsApply(p: Phase1, f: Finished): Promise<void> {
  const revisions = factsOf(f.after, 'plan-applied').map((a) => [a.rev, a.command]);
  assert.deepEqual(revisions, [], 'HEAD recorded no plan revision: the previous release\'s revision 2 is in force');
  assert.equal(f.view.planApplied()?.rev, 2);
  const plan = JSON.parse(readFileSync(p.l.plan, 'utf8')) as { units: { id: string; spec: string }[] };
  const last = plan.units.at(-1)!;
  const spec = JSON.parse(readFileSync(join(p.l.input, last.spec), 'utf8')) as object;
  writeFileSync(join(p.l.input, 'extra.json'), JSON.stringify({ ...spec, unit: 'extra', rev: 1 }));
  writeFileSync(p.l.plan, JSON.stringify({ ...plan, units: [...plan.units, { ...last, id: 'extra', spec: 'extra.json', after: [] }] }));
  const dry = await headCli(p, ['apply', '--dry-run', ...p.run]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), { dryRun: true, kind: 'accepted', rev: 2, nextRev: 3, changes: [{ type: 'unit-added', unit: 'extra' }], smoke: [], advisories: [], numbered: [], warnings: [] });
}

// ---------------------------------------------------------------------------------------------------
// Parks and resources

/** Rewrites a JSON input file of the fixture in place. */
function editJson<T>(path: string, edit: (value: T) => T): void {
  writeFileSync(path, `${JSON.stringify(edit(JSON.parse(readFileSync(path, 'utf8')) as T), null, 2)}\n`);
}

/** Waits until the starting release's host sample is clear and not busy; fails naming the last sample if it never is. */
async function clearHost(p: Phase1): Promise<void> {
  const { readHostSample, isBusy, isClear } = p.prev.modules.sample;
  const deadline = Date.now() + CLEAR_HOST_MS;
  for (;;) {
    const s = readHostSample();
    if (isClear(s) && !isBusy(s)) return;
    if (Date.now() >= deadline) assert.fail(`the host stayed busy for ${CLEAR_HOST_MS / 60_000} min (last sample ${JSON.stringify(s)}): this test needs a calm host`);
    await sleep(5_000);
  }
}

test('upgrade.park-adopted: a unit the previous release parked lane-blocked (operator-env) stays parked on HEAD; `resume page-id` re-runs its lanes, and it merges', T_CALM, async () => {
  const c = clean();
  let marker = '';
  // page-id's lane is killed by a signal (no verdict: blocked) until the marker exists.
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build], [], (l) => {
    marker = join(l.dir, 'page-id-lane-passes');
    editJson<{ lanes: { argv: readonly string[] }[] }>(join(l.input, 'page-id.json'), (spec) => ({
      ...spec,
      lanes: spec.lanes.map((lane) => ({ ...lane, argv: ['/bin/sh', '-c', '[ -e "$1" ] && exec node --test test/page-id.test.js; kill -KILL $$', 'lane', marker] })),
    }));
  });
  // The premise: a calm host. The previous release reads a lane killed by a signal on a busy host as host pressure
  // (a retryable host park), so the run starts only once its own sample says the host is clear.
  await clearHost(p);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    const item = await until('page-id parks on a raised needs-user', PHASE_MS, () => {
      const view = journalOf(p).view;
      return view.unit(unitId('page-id')).status === 'park-pending' ? view.needsUser()[0]?.id ?? null : null;
    });
    const ack = await p.cli(['ack', item, ...p.run]);
    assert.equal(ack.code, 0, ack.stderr);
    // Every unit merged, or parked with its item acknowledged: the previous release ends the arc itself.
    await until('the previous release ends the arc once the park is acknowledged', PHASE_MS, () => (isAlive(supervisor) ? null : true));
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const parked = mid.unit(unitId('page-id'));
  assert.deepEqual([parked.status, parked.decided?.stage, parked.decided?.outcome], ['park-pending', 'lanes', 'blocked']);
  assert.deepEqual(parked.decided?.park, { class: 'operator', kind: 'env' }, 'the previous release recorded the park class itself');
  assert.deepEqual(parked.park?.park, { class: 'operator', kind: 'env' }, 'HEAD reads the park as the previous release wrote it');
  const resume = await p.cli(['resume', 'page-id', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);
  writeFileSync(marker, '');

  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.deepEqual(factsOf(f.after, 'unparked').map((u) => u.unit), ['page-id'], 'resume page-id unparked it');
  assert.deepEqual(outcomesOf(f.after, 'page-id'), ['lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'], 'HEAD re-ran the lanes, and nothing before them');
});

test('upgrade.named-cpu-low-host: the previous release\'s plan\'s named resource `cpu` is reserved beside @cpu; on a one-CPU host HEAD refuses the DAG arc over capacity and changes nothing', T, async () => {
  const affinity = spawnSync('taskset', ['-c', '0', process.execPath, '-e', 'process.stdout.write(String(require("node:os").availableParallelism()))'], { encoding: 'utf8' });
  assert.equal(affinity.status, 0, `taskset: ${affinity.stderr}`);
  assert.equal(affinity.stdout, '1', 'taskset -c 0 leaves one CPU available');
  const withCpu = (resources: readonly string[]): readonly string[] => [...resources, 'cpu'];
  const { p, head } = await stoppedMidBuild(clean(), (l) => {
    type Plan = { resources: { name: string }[]; units: { spec: string; resources: string[] }[] };
    editJson<Plan>(l.plan, (plan) => {
      const [scratch] = plan.resources;
      assert.ok(scratch !== undefined && plan.resources.length === 1);
      // The same state-dir resource as `scratch`, under its own owner file.
      const cpu = JSON.parse(JSON.stringify(scratch).replaceAll('scratch', 'cpu')) as { name: string };
      assert.equal(cpu.name, 'cpu');
      for (const u of plan.units) editJson<{ resources: string[] }>(join(l.input, u.spec), (spec) => ({ ...spec, resources: [...withCpu(spec.resources)] }));
      return { ...plan, resources: [...plan.resources, cpu], units: plan.units.map((u) => ({ ...u, resources: [...withCpu(u.resources)] })) };
    });
  });
  // One CPU: a DAG arc's build asks 4 @cpu tokens, so the start is refused before any effect.
  const highWater = journalOf(p).view.highWater();
  const low = await runUntilExit('taskset', ['-c', '0', process.execPath, fixture('exec-cli.ts'), p.host, 'start', '--repo', p.l.repo, '--plan', p.l.plan, '--profile', 'default'], { env: process.env, timeoutMs: START_MS });
  assert.equal(low.code, 78, `start on one CPU: ${low.stdout} ${low.stderr}`);
  const refused = JSON.parse(low.stdout) as { kind: string; rejections: { kind: string; problem: { type: string; resource: string } }[] };
  assert.equal(refused.kind, 'refused');
  assert.ok(refused.rejections.length > 0 && refused.rejections.every((r) => r.kind === 'plan-invalid' && r.problem.type === 'over-capacity' && r.problem.resource === '@cpu'), low.stdout);
  assert.equal(journalOf(p).view.highWater(), highWater, 'the refused start appended nothing');
  const plan = requirePlanInForce(absPath(p.l.runDir), journalOf(p).view).plan;
  const specs = new Map(plan.units.map((u) => [u.id, loadSpec(absPath(join(p.l.input, u.spec)))] as const));
  assert.ok(overCapacity(plan, { cpu: 1 }, specs).length > 0, 'the previous release\'s arc is a DAG arc: over a one-CPU capacity');

  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const reserved = f.after.flatMap((e) => (e.type === 'intent' && e.kind === 'resource.transition' && e.expect.edge.type === 'reserve' ? [e.expect.resources] : []));
  assert.ok(reserved.some((units) => units.includes(resourceName('cpu'))), `HEAD reserved the named cpu: ${JSON.stringify(reserved)}`);
});

// ---------------------------------------------------------------------------------------------------
// The architect acting on HEAD's running arc

/** Replaces the plan's `direction`, as the architect would. */
const newDirection = (l: Layout): void =>
  editJson<{ direction: string }>(l.plan, (plan) => ({ ...plan, direction: `${plan.direction} Page identifiers are stable across releases.` }));

/** The queued command file's bytes. */
const commandBytes = (p: Phase1, id: string): Buffer => readFileSync(incomingPath(absPath(p.l.runDir), commandId(id)));

test('upgrade.apply-queued: an apply the previous release\'s CLI queues (`base` and `visionEdit`) on HEAD\'s running arc is applied as revision 2, its bytes unchanged, no default read', T, async () => {
  // page-id stays held until the apply lands: an arc-scoped apply waits for every unit to be idle. The edit is made
  // on the running arc, so HEAD's start finds the files in force and the revision is the command's.
  const { p, head } = await stoppedMidBuild(clean(), undefined, false);
  let id = '';
  let queued: Buffer | null = null;
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head, async () => {
      await until('HEAD\'s executor runs the arc', PHASE_MS, () => (factsOf(journalOf(p).events, 'executor-started').length > 1 ? true : null));
      newDirection(p.l);
      id = await submitOnPrevious(p, ['apply']);
      queued = commandBytes(p, id);
      await submitOnHead(p, ['resume', 'page-id']);
    });
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const body = (JSON.parse(queued!.toString('utf8')) as { body: Readonly<Record<string, unknown>> }).body;
  assert.deepEqual([body['type'], 'expectRev' in body, 'base' in body, 'visionEdit' in body], ['apply', false, true, true], 'the previous release\'s CLI queued the apply HEAD knows');
  const [fact, ...more] = factsOf(f.after, 'plan-applied');
  assert.ok(fact !== undefined && more.length === 0);
  assert.deepEqual([fact.rev, fact.command, fact.changes], [2, id, [{ type: 'plan-field', field: 'direction' }]]);
  assert.ok(queued !== null && commandBytes(p, id).equals(queued), 'the previous release\'s command file is never rewritten');
  assert.doesNotMatch(hostLogs(p), /roadmap: upgrade default \(apply\./, 'HEAD read the command as written: no default');
});

/**
 * page-id's lane waits at `marker` (writing `<marker>.reached`) until `<marker>.release` exists, then runs its test:
 * the architect acts on HEAD's running arc meanwhile.
 */
function holdLane(l: Layout, marker: string): void {
  editJson<{ lanes: { argv: readonly string[] }[] }>(join(l.input, 'page-id.json'), (spec) => ({
    ...spec,
    lanes: spec.lanes.map((lane) => ({
      ...lane,
      argv: ['/bin/sh', '-c', '[ -e "$1.release" ] || { : > "$1.reached"; while [ ! -e "$1.release" ]; do sleep 0.2; done; }; exec node --test test/page-id.test.js', 'lane', marker],
    })),
  }));
}

/** Submits `args` through HEAD's CLI and waits for the command's terminal receipt; returns the command id. */
async function submitOnHead(p: Phase1, args: readonly string[]): Promise<string> {
  const out = await headCli(p, [...args, ...p.run]);
  assert.equal(out.code, 0, out.stderr);
  const id = (JSON.parse(out.stdout) as { command: string }).command;
  const receipt = await until(`command ${id} ends`, PHASE_MS, () => terminalReceipt(absPath(p.l.runDir), commandId(id)));
  assert.equal(receipt.state, 'applied', JSON.stringify(receipt));
  return id;
}

/** Submits `args` through the previous release's CLI and waits for the command's terminal receipt; returns the command id. */
async function submitOnPrevious(p: Phase1, args: readonly string[]): Promise<string> {
  const out = await p.cli([...args, ...p.run]);
  assert.equal(out.code, 0, out.stderr);
  const id = (JSON.parse(out.stdout) as { command: string }).command;
  const receipt = await until(`the previous release's command ${id} ends`, PHASE_MS, () => terminalReceipt(absPath(p.l.runDir), commandId(id)));
  assert.equal(receipt.state, 'applied', JSON.stringify(receipt));
  return id;
}

/**
 * Acknowledges, through the previous release's CLI, every blocking needs-user still open (a superseded unit's park
 * escalation, which otherwise holds the arc open), and waits until the previous release records each ack.
 */
async function ackOpenItems(p: Phase1): Promise<void> {
  const open = journalOf(p).view.needsUser().filter((n) => n.blocking && n.ack === null).map((n) => n.id);
  for (const id of open) {
    const ack = await p.cli(['ack', id, ...p.run]);
    assert.equal(ack.code, 0, ack.stderr);
  }
  await until('the previous release records the acks', PHASE_MS, () => (journalOf(p).view.needsUser().every((n) => !open.includes(n.id) || n.ack !== null) ? true : null));
}

/** Every supervisor's and executor's stderr in the host dir (the executors' upgrade-default warnings land there). */
const hostLogs = (p: Phase1): string =>
  readdirSync(p.host).filter((n) => /^(supervisor\.[0-9a-f]+|executor\.\d+)\.err$/.test(n)).map((n) => readFileSync(join(p.host, n), 'utf8')).join('');

const RULING = 'C-3';
const RULING_TEXT = 'Every page identifier is built from slugify.';

test('upgrade.rule-on-adopted-arc: `roadmap rule` lands on the previous release\'s revision: constraints.md published, the owner\'s files never written; the arc then merges', T, async () => {
  let marker = '';
  const { p, head } = await stoppedMidBuild(clean(), (l) => {
    marker = join(l.dir, 'page-id-lane');
    holdLane(l, marker);
  });
  const ledger = join(p.l.input, 'rulings.md');
  const before = readFileSync(ledger);
  let id = '';
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head, async () => {
      await until('page-id waits at its lane on HEAD', PHASE_MS, () => (existsSync(`${marker}.reached`) ? true : null));
      const tip = git(p.l.repo, 'rev-parse', 'integration');
      const record = {
        schema: 'roadmap/ruling-m3', id: RULING, statement: RULING_TEXT, kind: 'decision', ruledBy: { type: 'architect' }, trigger: 'review', supersedes: [], condition: null,
        docRefs: [{ path: 'ARCHITECTURE.md', anchor: '#architecture', quotedText: 'A tiny library of pure string and number helpers.', relation: 'consistent' }],
        contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: [], evidence: [], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
        // The previous release's revision in force: its ledger, no obligations and no vision.
        consistency: { verdict: 'consistent', judgedRevs: { head: tip, ledgerSha256: bytesSha256(before), obligationsSha256: null, visionSha256: null, contracts: [] }, by: { type: 'architect' } },
      };
      const file = join(p.dir, 'C-3.json');
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      id = await submitOnHead(p, ['rule', file]);
      writeFileSync(`${marker}.release`, '');
    });
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const [fact, ...more] = factsOf(f.after, 'plan-applied');
  assert.ok(fact !== undefined && more.length === 0);
  assert.ok(readFileSync(ledger).equals(before), 'the owner\'s ledger is never written');
  const inForce = Buffer.from(`${before.toString('utf8')}${RULING} — ${RULING_TEXT}\n`, 'utf8');
  assert.deepEqual([fact.rev, fact.command, fact.source, fact.rulingsSha256, fact.publication?.pub], [2, id, { type: 'command', command: id }, bytesSha256(inForce), 'docs-1']);
  assert.ok(!existsSync(join(`${ledger}.d`, `${RULING}.json`)), 'nor a sidecar beside it');
  assert.match(git(p.l.repo, 'show', `integration:.roadmap/constraints.md`), new RegExp(`${RULING} — ${RULING_TEXT}`), 'constraints.md published');
});

/** The arc whose released residue pairs fill the host index to the compaction threshold (COMPACT_THRESHOLD). */
const FILLER = arcId('upgrade-filler');
const FILLERS = 64;

test('upgrade.compact-with-adopted-retry: the previous release\'s retry crashed after its disposition; HEAD\'s start compacts the index, keeping that pair byte for byte, and recovery releases it', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build, c.pageId.gate], [], (l) => {
    // The resource's teardown fails once: the first release of `scratch` leaves a residue.
    type Decl = { name: string; teardown: { argv: readonly string[] } };
    editJson<{ resources: Decl[] }>(l.plan, (plan) => ({
      ...plan,
      resources: plan.resources.map((r) => ({
        ...r,
        teardown: { ...r.teardown, argv: ['/bin/sh', '-c', 'if [ -e "$1/teardown-fails-once" ]; then rm "$1/teardown-fails-once"; exit 1; fi; rm -f "$1/scratch.owner" && rm -rf "$1/scratch"', 'teardown', l.resource] },
      })),
    }));
    writeFileSync(join(l.resource, 'teardown-fails-once'), '');
  });
  await crashPrevious(p, { label: 'retry.after-disposition', occurrence: 1 });
  const scratch = resourceName(RESOURCE);
  const mid = journalOf(p).view;
  const held = mid.resources().get(scratch)?.status;
  assert.ok(held !== undefined && held.state === 'cleaning' && held.holder.type === 'retry', `scratch is cleaning under the retry: ${JSON.stringify(held)}`);
  const host = absPath(p.host);
  const previousPair = readResidues(host).map((l) => canonicalJson(bodyOf(l)));
  assert.equal(previousPair.length, 2, 'the residue and its cleaned disposition');

  // Another arc's released pairs, its log readable (an empty one) in the repo's runtime dir.
  const fillerRunDir = absPath(join(p.l.repo, '.git', 'roadmap-runtime', FILLER));
  mkdirSync(fillerRunDir, { recursive: true });
  openJournal(fillerRunDir, FILLER).close();
  for (let i = 1; i <= FILLERS; i++) {
    const key = { arc: FILLER, unit: unitId('filler'), inv: invocationId(opId(FILLER, i), 1), resource: resourceName(`filler${i}`) };
    recordResidue(host, { type: 'residue', key, teardown: { argv: ['true'], cwd: absPath('/tmp'), env: {} }, label: `filler ${i}` });
    recordDisposition(host, { type: 'disposition', key, disposition: 'cleaned', by: { arc: FILLER, inv: invocationId(opId(FILLER, 1000 + i), 1) } });
  }
  const before = readFileSync(join(p.host, 'residues.jsonl'));

  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, remainingSteps(p, c));
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const archives = readdirSync(p.host).filter((n) => RESIDUE_ARCHIVE.test(n));
  assert.equal(archives.length, 1, 'HEAD\'s start compacted the index once');
  assert.ok(readFileSync(join(p.host, archives[0]!)).equals(before), 'the archive is the index as it stood, byte for byte');
  assert.deepEqual(readResidues(host).map((l) => canonicalJson(bodyOf(l))), previousPair, 'the fillers went; the previous release\'s pair stays unchanged, and no second disposition');
  assert.deepEqual(f.view.resources().get(scratch)?.status, { state: 'free' }, 'recovery released the previous release\'s retry');
});

/**
 * The clean scenario's steps the previous release did not reach before it crashed (its calls matched the smoke, then
 * the first steps in order): what HEAD plays.
 */
function remainingSteps(p: Phase1, c: Clean): readonly M1Step[] {
  const all = [...c.slug, c.pageId.planCheck, c.pageId.build, c.pageId.gate];
  const calls = readCalls(join(p.fakeDir, 'scenario.json'));
  assert.deepEqual(calls.map((call) => call.step), calls.map((_, i) => i), 'the previous release\'s calls matched its first steps, in order');
  return all.slice(calls.length - SMOKE_CALLS);
}

// ---------------------------------------------------------------------------------------------------
// HEAD with arc judgments: its CLI and fakes directly (the M1 scenario format has unit roles only)

type HeadRun = Readonly<{ exit: ExitReason; calls: readonly CallRecord[]; after: readonly Event[]; view: JournalView }>;

/**
 * Starts HEAD on the fixture with `steps` behind its fake backends (`binDirs` next on PATH) and waits for the run to end;
 * `during` runs alongside.
 */
async function runOnHead(
  p: Phase1, steps: readonly Step[], during: () => Promise<void>, name = 'fake-head', binDirs: readonly string[] = [], expectedDefaults: readonly string[] = [],
): Promise<HeadRun> {
  const highWater = journalOf(p).view.highWater();
  const s = writeScenario(join(p.dir, name), steps);
  const env = { ...process.env, PATH: [s.binDir, ...binDirs, process.env['PATH'] ?? ''].join(':') };
  const start = await runUntilExit(process.execPath, [fixture('exec-cli.ts'), p.host, 'start', '--repo', p.l.repo, '--plan', p.l.plan, '--profile', 'default'], { env, timeoutMs: START_MS });
  assert.equal(start.code, 0, `HEAD start: ${start.stdout} ${start.stderr}`);
  const ready = JSON.parse(start.stdout) as { kind: string; generation: number; supervisor: number };
  assert.equal(ready.kind, 'ready', start.stdout);
  const stat = statOf(ready.supervisor);
  assert.ok(stat !== null);
  const supervisor = { pid: ready.supervisor, start: stat.start };
  await Promise.all([until('HEAD ends the arc', PHASE_MS, () => (isAlive(supervisor) ? null : true)), during()]);
  const line = lastLine(executorLogs(absPath(p.host), ready.generation).out);
  assert.ok(line !== null, 'HEAD\'s executor printed its exit line');
  const calls = readCalls(s.path);
  assert.deepEqual(calls.map((c) => c.step).sort((a, b) => a! - b!), steps.map((_, i) => i), 'HEAD\'s calls matched every step of its scenario');
  assertNoDefaultRead(p, expectedDefaults);
  const { view, events } = journalOf(p);
  return { exit: JSON.parse(line) as ExitReason, calls, after: events.filter((e) => e.seq > highWater), view };
}

/** The architect's opt-in: one purpose clause, one must-hold obligation witnessed by slug's tests through a node-test lane. */
const VISION = {
  schema: 'roadmap/vision-m3', rev: 1, confirmation: null,
  clauses: [
    { id: 'V-1', kind: 'purpose', text: 'Every page has a stable, readable identifier.', rank: null, state: 'active' },
    { id: 'V-2', kind: 'world', text: 'A reader shares a link to any page and it still works a year later.', rank: null, state: 'active' },
  ],
  questions: [],
};
const SLUG_LANE = {
  id: 'slug-journey', argv: ['node', '--test', 'test/slug.test.js'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, cadence: 'build',
  resources: [], evidenceGlobs: [], reporter: 'node-test',
} as const;

/** An arc lane as `release` declares it: before 1.0.0-dev.17, a `build` cadence is `tier: 'fast'` (lane topology). */
function laneAs(release: Release, lane: Readonly<{ cadence: 'build' }>): object {
  if (!BEFORE_DEV17.has(release)) return lane;
  const { cadence: _cadence, ...rest } = lane;
  return { ...rest, tier: 'fast' };
}
const SLUG_WITNESS = { lane: SLUG_LANE.id, testIds: ['slugify never starts or ends with a hyphen (A2)'] };

/**
 * The obligations file: I-1 witnessed through `lane` by `witness`, its proof judged on the lane's rev as `revOf` (HEAD's
 * `laneRevOf`, or the previous release's) computes it. The default lane and witness declare no `testPaths` and no
 * `files`, which only a corpus arc's Phase 0 requires.
 */
function obligations(lane: object = SLUG_LANE, witness: object = SLUG_WITNESS, revOf: (file: object) => string = (file) => laneRevOf(parseObligations(file).lanes[0]!)): unknown {
  const empty = { schema: 'roadmap/obligations-m3', cutLine: 'the arc ends when page-id ships', lanes: [lane], obligations: [], mapping: { paths: [] } };
  const laneRev = revOf(empty);
  return {
    ...empty,
    obligations: [{
      id: 'I-1', rev: 1, statement: 'slugify never returns a leading or trailing hyphen.',
      docRef: { path: '.roadmap/contracts/one.md', anchor: '#slugifytext', quotedText: 'The result never starts or ends with' },
      serves: ['V-1'], witness, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev, witness },
      deliveredBy: [], activation: 'must-hold', contracts: ['.roadmap/contracts/one.md'], state: { type: 'active' },
    }],
  };
}

/**
 * The opt-in story: stopped mid-build on `release`, `page-id` left held; on HEAD the architect writes a vision, the obligations and
 * `holistic`, `queue` submits the apply (and waits for it applied; returns its command id), then `resume page-id`: the
 * baseline job, the drift audit (audit-1, L ∩ {drift, vision} empty: all of L) and its no-op checkpoint (ckpt-1), the
 * brake on page-id's candidate, the final audit (audit-2) and its no-op checkpoint (ckpt-2), `arc-completed`.
 */
async function optInHolistic(queue: (p: Phase1) => Promise<string>, release: Release = PREVIOUS_RELEASE): Promise<Readonly<{ p: Phase1; r: HeadRun; id: string }>> {
  // page-id stays held until the apply lands: an arc-scoped apply waits for every unit to be idle.
  const { p, head } = await stoppedMidBuild(clean(), undefined, false, [], release);
  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: head }, 'default'),
    ...(['1', '2'] as const).flatMap((n) => [lensStep(`audit-${n}`, 'invariants'), checkpointStep(`ckpt-${n}`, checkpointAnswer({ decision: 'no-op' }))]),
  ];
  let id = '';
  const scope = scopeOf(p);
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {
      await until('HEAD\'s executor runs the arc', PHASE_MS, () => (factsOf(journalOf(p).events, 'executor-started').length > 1 ? true : null));
      writeFileSync(join(p.l.input, 'vision.json'), `${JSON.stringify(VISION, null, 2)}\n`);
      writeFileSync(join(p.l.input, 'obligations.json'), `${JSON.stringify(obligations(), null, 2)}\n`);
      editJson<object>(p.l.plan, (plan) => ({ ...plan, holistic: { vision: 'vision.json', advances: ['V-1', 'V-2'], obligations: 'obligations.json', audit: { lenses: ['invariants'] } } }));
      id = await queue(p);
      await submitOnHead(p, ['resume', 'page-id']);
    });
  } finally {
    await teardown(scope);
  }
  assert.deepEqual(r.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  const [opted, ...more] = factsOf(r.after, 'plan-applied');
  assert.ok(opted !== undefined && more.length === 0);
  assert.equal(opted.command, id);
  assert.ok(opted.changes.some((ch) => ch.type === 'holistic') && opted.visionSha256 !== undefined, JSON.stringify(opted.changes));
  const witnessed = factsOf(r.after, 'witnessed');
  assert.ok(witnessed.some((w) => w.for.type === 'job' && w.for.job.startsWith('baseline-')), 'the baseline job witnessed the arc lanes');
  assert.ok(witnessed.some((w) => w.for.type === 'candidate' && w.for.unit === 'page-id'), 'page-id\'s candidate ran the brake');
  assert.ok(factsOf(r.after, 'audit-ended').some((a) => a.outcome === 'completed' && a.covered.some((cv) => cv.lens === 'invariants')), 'an audit covered the invariants lens');
  assert.deepEqual(factsOf(r.after, 'bundle-decided').map((b) => [b.job, b.outcome]), [['ckpt-1', { kind: 'no-op' }], ['ckpt-2', { kind: 'no-op' }]]);
  assert.deepEqual(factsOf(r.after, 'audit-started').map((a) => [a.job, a.triggers.map((t) => t.type)]), [['audit-1', ['drift']], ['audit-2', ['final']]]);
  const [completed] = factsOf(r.after, 'arc-completed');
  assert.ok(completed !== undefined);
  assert.equal(completed.planRev, 2);
  assert.equal(completed.head, git(p.l.repo, 'rev-parse', 'integration'));
  assert.equal(r.view.holistic().on, true);
  return { p, r, id };
}

test('upgrade.opt-in-holistic: an architect apply adds `holistic` to the previous release\'s arc mid-run: the baseline job, the drift audit, the brake on page-id\'s candidate, the final audit, no-op checkpoints, arc-completed', T, async () => {
  await optInHolistic((p) => submitOnHead(p, ['apply', '--vision-edit']));
});

test('upgrade.vision-edit-queued: the opt-in apply the previous release\'s CLI queues with `--vision-edit` changes the vision and is applied as the declared vision edit it carries, never refused as vision-leak; no default read', T, async () => {
  let body: Readonly<Record<string, unknown>> = {};
  const { p } = await optInHolistic(async (q) => {
    const id = await submitOnPrevious(q, ['apply', '--vision-edit']);
    body = (JSON.parse(commandBytes(q, id).toString('utf8')) as { body: Readonly<Record<string, unknown>> }).body;
    return id;
  });
  assert.deepEqual([body['type'], 'expectRev' in body, body['visionEdit']], ['apply', false, true], 'the previous release\'s CLI queued its declared vision edit');
  assert.doesNotMatch(hostLogs(p), /roadmap: upgrade default \(apply\./, 'HEAD read the command as written: no default');
});

// ---------------------------------------------------------------------------------------------------
// Generic adoption: a crash with the ff open, the repo config, the target kind

/**
 * The fingerprint story on `release`: it approves page-id and crashes with its ff open; `gate` checks the gate's
 * `judgment-inputs` it recorded. HEAD's recovery compares the fingerprint byte for byte and publishes, with no new judgment.
 */
async function fingerprintOpenFf(release: Release, gate: (inputs: Extract<Fact, { kind: 'judgment-inputs' }>) => void): Promise<void> {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build, c.pageId.gate], [], undefined, release);
  await crashPrevious(p, { label: 'ff.act-start', occurrence: 1, unit: 'page-id' });
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const open = mid.opsOf('integration.ff').filter((i) => mid.doneOf(i.op) === null);
  assert.equal(open.length, 1, 'page-id\'s ff intent is open');
  const approval = mid.unit(unitId('page-id')).approval;
  assert.ok(approval !== null, 'the starting release recorded page-id\'s approval');
  assert.equal('corpus' in approval.fingerprint, false, 'a non-corpus arc\'s fingerprint has no corpus pin');
  const gateInputs = factsOf(journalOf(p).events, 'judgment-inputs').filter((i) => i.unit === 'page-id' && i.stage === 'gate');
  assert.equal(gateInputs.length, 1);
  gate(gateInputs[0]!);

  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, []);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.equal(f.calls.length, SMOKE_CALLS, 'no judgment, no build: the smoke only');
  assert.deepEqual(factsOf(f.after, 'judgment-inputs'), []);
  assert.deepEqual(outcomesOf(f.after, 'page-id'), ['ff:published', 'snapshot:published'], 'the recovered ff published, then the snapshot');
  const done = f.view.doneOf(open[0]!.op);
  assert.ok(done !== null && done.kind === 'integration.ff');
  assert.equal(canonicalJson(f.view.unit(unitId('page-id')).approval?.fingerprint), canonicalJson(approval.fingerprint), 'the approval is read as the starting release wrote it');
}

/**
 * Proportional review (dev.17): page-id's gate revised on dev.16 and its fix round was stopped mid-call, so
 * HEAD's gate rules on a prior round no findings ledger recorded. The revising answer has no defect, reraises, hunk or
 * rulings and its inputs no review (each read with its default, warned); none of its findings is ledgered, so HEAD's gate is
 * given an empty ledger, no disputes and a full review, and nothing is refused for the ledger's sake.
 */
test('upgrade.dev16.review-unledgered: a gate revise dev.16 recorded, its fix round stopped mid-call, finishes on HEAD: no ledger, the dev.16 answer read with the review defaults, warned', T, async () => {
  const c = clean();
  const files = pageIdFiles(c);
  const revise: M1Step = {
    role: 'gate',
    answer: {
      decision: 'revise', directives: ['Test pageId with a negative n.'], reasons: ['B3 is under-tested.'], premises: [], unreviewed: [], clusters: null, rulings: [],
      findings: [{ severity: 'blocking', path: 'test/page-id.test.js', text: 'No negative n case.', contractRef: null, experiments: [], debt: null, defect: 'test-inadequate', reraises: null, hunk: null }],
    },
  };
  const midFix: Step = { as: 'codex', expect: { argv: ['exec', 'resume'] }, acts: [{ type: 'barrier', name: MID_CALL, timeoutMs: PHASE_MS }] };
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build, revise], [midFix], undefined, DEV16_RELEASE);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await midCall(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.deepEqual(outcomesOf(journalOf(p).events, 'page-id').filter((o) => o.startsWith('gate:')), ['gate:revise'], 'dev.16 revised page-id');
  assert.deepEqual([mid.unit(unitId('page-id')).stage, mid.unit(unitId('page-id')).status], ['build', 'held']);
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  const negative = `${files['test/page-id.test.js']}\ntest('pageId refuses a negative n (B3)', () => {\n  assert.throws(() => pageId('x', -1), RangeError);\n});\n`;
  const fix: M1Step = { ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE], acts: [{ type: 'commit', message: 'negative n', files: { 'test/page-id.test.js': negative } }] };
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [fix, c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const gated = factsOf(f.after, 'judgment-inputs').filter((i) => i.stage === 'gate' && i.unit === 'page-id');
  assert.equal(gated.length, 1);
  assert.deepEqual(gated[0]!.review, { ledger: [], disputes: [], delta: null }, 'HEAD\'s gate was given an empty ledger and a full review');
  assert.deepEqual(factsOf(f.events, 'review-ledger'), [], 'no finding of dev.16\'s gate is ledgered, and HEAD\'s approval minted none');
  const logs = hostLogs(p);
  for (const kind of ['judgment-inputs.review', 'gate.finding.review', 'gate.rulings']) {
    assert.ok(logs.includes(`roadmap: upgrade default (${kind})`), `HEAD read dev.16's gate round with the ${kind} default, and warned`);
  }
  // dev.17: HEAD ran page-id's lanes on the arc's revisions, which record no systems map: read as none, and warned.
  assert.ok(logs.includes('roadmap: upgrade default (plan-applied.systemsMap)'), 'HEAD read the revisions without a systems map, and warned');
  // dev.17: the arc ran without a flaky ledger: HEAD's deflake job reads it empty at the upgrade (warned), and with no flake
  // since, mints nothing.
  assert.ok(logs.includes('roadmap: upgrade default (flaky.ledger)'), 'HEAD read the arc without a flaky ledger as an empty one, and warned');
  assert.deepEqual(factsOf(f.after, 'flake-observed'), []);
  assert.deepEqual(factsOf(f.after, 'plan-applied').filter((x) => x.source.type === 'deflake'), [], 'no deflake unit');
});

test('upgrade.fingerprint-open-ff: the previous release approved page-id and crashed with its ff open; HEAD\'s recovery compares its fingerprint byte for byte and publishes, with no new judgment', T, async () => {
  await fingerprintOpenFf(PREVIOUS_RELEASE, (inputs) => {
    assert.ok(inputs.diffShown !== undefined && inputs.diffShown.inlined.length > 0, 'the previous release\'s gate recorded what its bounded diff showed');
    assert.deepEqual(gateDiffShownOf(inputs), inputs.diffShown, 'read as recorded');
    assert.equal(inputs.largeDiff, null, 'the previous release\'s gate recorded its diff under the large-diff threshold');
    assert.equal(gateLargeDiffOf(inputs), null, 'read as recorded');
  });
});

test('upgrade.dev11.fingerprint-open-ff: dev.11 approved page-id and crashed with its ff open, its gate recording no diffShown and no largeDiff (read with the dev.12 defaults); HEAD\'s recovery compares its fingerprint byte for byte and publishes, with no new judgment', T, async () => {
  await fingerprintOpenFf(DEV11_RELEASE, (inputs) => {
    assert.equal(inputs.diffShown, undefined, 'dev.11\'s gate recorded no diffShown');
    assert.deepEqual(gateDiffShownOf(inputs), { inlined: [], notInlined: [] }, 'read as nothing recorded (the dev.12 default)');
    assert.equal(inputs.largeDiff, undefined, 'dev.11\'s gate recorded no largeDiff');
    assert.equal(gateLargeDiffOf(inputs), null, 'read as under the large-diff threshold (the dev.12 default)');
  });
});

test('upgrade.config-without-chain: an adopted arc whose repo config names no chain K finishes on HEAD with no chain row applied, and its chain is itself alone', T, async () => {
  const { p, head } = await stoppedMidBuild(clean());
  const config = JSON.parse(readFileSync(join(p.l.repo, '.roadmap', 'config.json'), 'utf8')) as object;
  assert.equal('chain' in config, false, 'the previous release\'s fixture repo config names no chain K');
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.equal(f.report.status.chain, null, 'status shows no chain outside a corpus arc');
  const out = await headCli(p, ['chain', 'status', '--repo', p.l.repo]);
  assert.equal(out.code, 0, out.stderr);
  const chain = JSON.parse(out.stdout) as { arcs: { arc: string; previousArc: string | null }[]; k: number | null; unackedStarts: string[] };
  assert.deepEqual([chain.k, chain.arcs.map((a) => [a.arc, a.previousArc])], [null, [[p.l.arc, null]]]);
});

test('upgrade.target-kind-fixed: an apply cannot switch an adopted architecture-doc arc to a corpus one (target-kind-changed)', T, async () => {
  const { p, head } = await stoppedMidBuild(clean());
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  // The architect moves the plan files onto a corpus target (pin, Phase-0 record, anchored obligations, a fake forge's gh).
  const binDir = join(p.dir, 'bin-gh');
  mkdirSync(binDir, { recursive: true });
  corpusTarget({ arc: p.l.arc, repo: p.l.repo, planPath: p.l.plan, runDir: p.l.runDir, hostDir: p.host, binDir, scenarioPath: '', scenarioDir: '' }, { obligations: obligations() as Record<string, unknown>, advances: ['V-1'] });
  const dry = await headCli(p, ['apply', '--dry-run', ...p.run]);
  const out = JSON.parse(dry.stdout) as { kind: string; reasons?: string[] };
  assert.equal(out.kind, 'rejected', dry.stdout);
  assert.ok(out.reasons?.some((reason) => reason.startsWith('target-kind-changed')), dry.stdout);
});

// ---------------------------------------------------------------------------------------------------
// Routing: HEAD binds an earlier release's revisions through its own seat table

/**
 * The routing story on `release`: stopped mid-build, `page-id` left held; on HEAD the architect's `apply` (a new
 * `direction`) and `resume page-id`. HEAD's revision carries the role set the release recorded; no `routing-changed`; HEAD's
 * starts record the host fingerprint; `status` spend resolves every metered call. Returns the routing revs the release's
 * dispatches recorded, the rev HEAD resolves for its revision, its stack, and HEAD's judgments.
 */
async function routingStable(release: Release): Promise<Readonly<{
  revs: ReadonlySet<string>; resolved: string; stack: ReturnType<typeof provenanceStack>; judged: readonly Extract<Fact, { kind: 'judgment-inputs' }>[];
}>> {
  const { p, head } = await stoppedMidBuild(clean(), undefined, false, [], release);
  const before = journalOf(p).events;
  const [rev1] = factsOf(before, 'plan-applied');
  assert.ok(rev1 !== undefined && rev1.routingProvenance.arcRoles !== undefined, 'the starting release records its role set');
  const revs = new Set<string>(factsOf(before, 'dispatch').map((d) => d.record.routingRev));
  assert.equal(revs.size, 1, 'one arc routing rev under the starting release');
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head, async () => {
      await until('HEAD\'s executor runs the arc', PHASE_MS, () => (factsOf(journalOf(p).events, 'executor-started').length > 1 ? true : null));
      newDirection(p.l);
      await submitOnHead(p, ['apply']);
      await submitOnHead(p, ['resume', 'page-id']);
    });
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const [rev2, ...more] = factsOf(f.after, 'plan-applied');
  assert.ok(rev2 !== undefined && more.length === 0);
  assert.deepEqual(rev2.routingProvenance.arcRoles, rev1.routingProvenance.arcRoles, 'HEAD\'s revision carries the role set the starting release recorded');
  // The fixture's plan has no milestones: HEAD's walk roles are not in force.
  const stack = provenanceStack(rev2.routingProvenance, 'none', null, false);
  const resolved = resolveRouting(stack).rev;
  const judged = factsOf(f.after, 'judgment-inputs');
  assert.ok(judged.length > 0);
  assert.deepEqual(factsOf(f.after, 'stage-outcome').filter((o) => o.outcome === 'routing-changed'), [], 'no routing-changed');
  const started = factsOf(f.after, 'executor-started');
  assert.ok(started.length > 0 && started.every((s) => s.host !== undefined), 'HEAD\'s starts record the host fingerprint');

  const out = await headCli(p, ['status', ...p.run]);
  assert.equal(out.code, 0, out.stderr);
  const spend = (JSON.parse(out.stdout) as { spend: { byRole: { calls: number }[]; byModel: { models: { model: string; calls: number }[]; unresolvedRevs: string[] } } }).spend;
  const total = (xs: readonly { calls: number }[]): number => xs.reduce((n, x) => n + x.calls, 0);
  const historical = factsOf(before, 'meter');
  assert.ok(historical.length > 0 && historical.every((f) => f.prompt === undefined), 'adopted facts without prompt still resolve spend');
  const metered = meterOf(journalOf(p).events);
  assert.deepEqual(spend.byModel.unresolvedRevs, []);
  assert.equal(total(spend.byModel.models), total(metered.bySeat), 'every metered seat call resolves to a model');
  assert.equal(total(spend.byRole), total(metered.byRole));
  return { revs, resolved, stack, judged };
}

for (const release of [PREVIOUS_RELEASE, DEV20_RELEASE]) {
  const label = release === DEV20_RELEASE ? 'dev20.' : '';
  test(`upgrade.${label}routing-stable: the ${release.version} arc keeps its role set, never parks for routing, and resolves historical spend`, T, async () => {
    const { revs, resolved, stack, judged } = await routingStable(release);
    const previous = await loadFrom<typeof import('../../src/routing/layers.ts')>(release, 'src/routing/layers.ts');
    assert.ok(revs.has(previous.resolveRouting(stack).rev), 'the archived release reproduces its recorded revision');
    if (release === DEV20_RELEASE) {
      assert.ok(!revs.has(resolved), 'the summit effort changed xhigh to high; HEAD re-pins through the current catalogue');
    } else {
      assert.ok(revs.has(resolved), 'dev.21 already uses the current seat table; the routing rev stays stable');
    }
    for (const ji of judged) assert.equal(ji.routingRev, resolved, `${ji.unit} ${ji.stage}: judged under HEAD's current rev`);
  });
}


test('upgrade.dev16.routing-stable: an arc dev.16 started keeps its role set on HEAD; its routing rev moves by HEAD\'s seats and summit effort (frontier judgments, efficient builds) and re-pins without a park or routing-changed; spend resolves', T, async () => {
  const { revs, resolved, stack, judged } = await routingStable(DEV16_RELEASE);
  const previous = await loadFrom<typeof import('../../src/routing/layers.ts')>(DEV16_RELEASE, 'src/routing/layers.ts');
  assert.ok(revs.has(previous.resolveRouting(stack).rev), 'dev.16 reproduces its recorded seats and xhigh summit binding');
  assert.ok(!revs.has(resolved), 'HEAD\'s seat table moved the rev');
  for (const ji of judged) assert.ok(revs.has(ji.routingRev) || ji.routingRev === resolved, `${ji.unit} ${ji.stage}: judged under dev.16's rev or HEAD's`);
  assert.ok(judged.some((ji) => ji.stage === 'gate' && ji.routingRev === resolved), 'page-id re-pinned: its gate judged under HEAD\'s rev');
});

test('upgrade.dev11.routing-stable: an arc dev.11 started keeps its role set on HEAD; its routing rev moves by HEAD\'s seats and summit effort (the gate ladder) and re-pins without a park or routing-changed; spend resolves', T, async () => {
  const { revs, resolved, stack, judged } = await routingStable(DEV11_RELEASE);
  const previous = await loadFrom<typeof import('../../src/routing/layers.ts')>(DEV11_RELEASE, 'src/routing/layers.ts');
  assert.ok(revs.has(previous.resolveRouting(stack).rev), 'dev.11 reproduces its recorded seats and xhigh summit binding');
  assert.ok(!revs.has(resolved), 'HEAD\'s seat table moved the rev');
  for (const ji of judged) assert.ok(revs.has(ji.routingRev) || ji.routingRev === resolved, `${ji.unit} ${ji.stage}: judged under dev.11's rev or HEAD's`);
  assert.ok(judged.some((ji) => ji.stage === 'gate' && ji.routingRev === resolved), 'page-id re-pinned: its gate judged under HEAD\'s rev');
});

// ---------------------------------------------------------------------------------------------------
// The records 1.0.0-dev.11 added (re-entries' `fixes`, in-force inputs, declared witnesses), over an arc the previous
// release started

/** A plan-check that finds page-id infeasible; played twice (its seat, then the escalation seat), it parks page-id. */
const INFEASIBLE: M1Step = {
  role: 'planCheck',
  answer: { decision: 'infeasible', reasons: ['Contract one cannot be met as written.'], patch: null, risk: 'med', notes: 'Contract one contradicts itself.', premises: [], visionConflict: [], scopeGrowth: [], staleLinks: [] },
};
const REENTRY = 'page-id-2';

/** What the re-entry's spec adds to page-id's: the redesign its retry runs under. */
const REENTRY_FACT = { id: 'F2', text: 'Contract one is satisfiable: slugify already returns no leading or trailing hyphen.' };

/** The architect re-enters `page-id` as REENTRY (its spec, one fact more, and scope), naming the failure it fixes. */
function reenterPageId(l: Layout, fixes: string): void {
  type Unit = { id: string; spec: string };
  const spec = JSON.parse(readFileSync(join(l.input, 'page-id.json'), 'utf8')) as { facts: object[] };
  writeFileSync(join(l.input, `${REENTRY}.json`), `${JSON.stringify({ ...spec, unit: REENTRY, rev: 1, facts: [...spec.facts, { ...REENTRY_FACT, state: 'active' }] }, null, 2)}\n`);
  editJson<{ units: Unit[] }>(l.plan, (plan) => {
    const old = plan.units.find((u) => u.id === 'page-id')!;
    return { ...plan, units: [...plan.units, { ...old, id: REENTRY, spec: `${REENTRY}.json`, reenters: { unit: 'page-id', fixes } }] };
  });
}

test('upgrade.reentry-with-fixes: a re-entry the previous release applied, naming the failure it fixes, stays in force on HEAD, never classified again: HEAD finishes it, and a later apply is accepted', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, INFEASIBLE, INFEASIBLE, c.pageId.planCheck], [midBuild(pageIdFiles(c))]);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await until('page-id parks infeasible', PHASE_MS, () => (journalOf(p).view.unit(unitId('page-id')).status === 'park-pending' ? true : null));
    const failed = journalOf(p).view.unit(unitId('page-id')).failures.at(-1)!.fact;
    reenterPageId(p.l, `page-id/${failed.stage}#${failed.attempt}`);
    await submitOnPrevious(p, ['apply']);
    await midCall(p);
    await ackOpenItems(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const failed = mid.unit(unitId('page-id')).failures.at(-1)!.fact;
  const fixes = `page-id/${failed.stage}#${failed.attempt}`;
  const held = mid.unit(unitId(REENTRY));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['build', 'held', 'interrupted']);
  const inForce = requirePlanInForce(absPath(p.l.runDir), mid).plan.units.find((u) => u.id === REENTRY);
  assert.deepEqual(inForce?.reenters, { unit: unitId('page-id'), fixes }, 'the re-entry in force names the failure it fixes');
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  const steps = headFakeSteps({ steps: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] }, 'default');
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {});
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal(r.view.unit(unitId(REENTRY)).status, 'retired', 'HEAD merged the re-entry');
  assert.deepEqual(factsOf(r.after, 'plan-applied'), [], 'HEAD\'s start found the previous release\'s revision in force');
  newDirection(p.l);
  const dry = await headCli(p, ['apply', '--dry-run', ...p.run]);
  assert.equal(dry.code, 0, dry.stderr);
  const out = JSON.parse(dry.stdout) as { kind: string; changes: unknown[] };
  assert.deepEqual([out.kind, out.changes], ['accepted', [{ type: 'plan-field', field: 'direction' }]], dry.stdout);
});

/** The architect's ruling C-3 on the revision in force: its ledger, no obligations and no vision. */
const rulingRecord = (p: Phase1, ledger: Buffer): object => ({
  schema: 'roadmap/ruling-m3', id: RULING, statement: RULING_TEXT, kind: 'decision', ruledBy: { type: 'architect' }, trigger: 'review', supersedes: [], condition: null,
  docRefs: [{ path: 'ARCHITECTURE.md', anchor: '#architecture', quotedText: 'A tiny library of pure string and number helpers.', relation: 'consistent' }],
  contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: [], evidence: [], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
  consistency: {
    verdict: 'consistent', judgedRevs: { head: git(p.l.repo, 'rev-parse', 'integration'), ledgerSha256: bytesSha256(ledger), obligationsSha256: null, visionSha256: null, contracts: [] },
    by: { type: 'architect' },
  },
});

const REDIRECT_FACT = { id: 'F2', text: 'Contract one is unambiguous about the empty slug.' };

test('upgrade.inputs-in-force: a plan-check\'s spec patch and a ruling the previous release kept in force without writing the owner\'s files rebase cleanly on HEAD: its start and an architect apply keep both in force, and nothing writes the owner\'s files', T, async () => {
  const c = clean();
  const redirect: M1Step = { role: 'planCheck', answer: { ...((c.pageId.planCheck as Exclude<M1Step, { role: 'build' }>).answer as object), decision: 'redirect', patch: [{ op: 'add', section: 'facts', item: REDIRECT_FACT }] } };
  const p = await preparePrevious([...c.slug, redirect, c.pageId.planCheck], [midBuild(pageIdFiles(c))]);
  const ledger = join(p.l.input, 'rulings.md');
  const sidecar = join(`${ledger}.d`, `${RULING}.json`);
  const specPath = join(p.l.input, 'page-id.json');
  const ledgerBefore = readFileSync(ledger);
  const specBefore = readFileSync(specPath);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await midCall(p);
    const file = join(p.dir, 'C-3.json');
    writeFileSync(file, `${JSON.stringify(rulingRecord(p, ledgerBefore), null, 2)}\n`);
    await submitOnPrevious(p, ['rule', file]);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  // The previous release keeps both in its revision, never in the owner's files (since 1.0.0-dev.11).
  assert.ok(readFileSync(ledger).equals(ledgerBefore) && !existsSync(sidecar) && readFileSync(specPath).equals(specBefore), 'the previous release wrote nothing into the owner\'s files');
  const ruled = journalOf(p).view.planApplied();
  assert.equal(ruled?.rev, 2, 'the ruling\'s revision');
  // The redirect's patch is rev 2; the approving plan-check on it lands its design record as rev 3 (dev.17, the design pass).
  assert.equal(journalOf(p).view.unit(unitId('page-id')).spec?.rev, 3, 'page-id runs at its designed rev, over the patched rev 2');

  let id = '';
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate], async () => {
      await until('HEAD\'s executor runs the arc', PHASE_MS, () => (factsOf(journalOf(p).events, 'executor-started').length > 1 ? true : null));
      newDirection(p.l);
      id = await submitOnHead(p, ['apply']);
      await submitOnHead(p, ['resume', 'page-id']);
    });
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const [fact, ...more] = factsOf(f.after, 'plan-applied');
  assert.ok(fact !== undefined && more.length === 0, 'HEAD\'s start found the files in force: only the apply revised the plan');
  assert.deepEqual([fact.rev, fact.command, fact.changes, fact.rulingsSha256], [3, id, [{ type: 'plan-field', field: 'direction' }], ruled!.rulingsSha256], 'C-3 stays in force');
  assert.equal(f.view.unit(unitId('page-id')).spec?.rev, 3, 'page-id merged at its designed rev, over the patched rev 2');
  assert.ok(readFileSync(ledger).equals(ledgerBefore) && !existsSync(sidecar) && readFileSync(specPath).equals(specBefore), 'HEAD wrote nothing into the owner\'s files');
  const constraints = git(p.l.repo, 'show', 'integration:.roadmap/constraints.md');
  assert.equal(constraints.split(`${RULING} — ${RULING_TEXT}`).length - 1, 1, 'C-3 published once');
});

/** A corpus arc's lane and witness, declared (`testPaths`, `files`) as Phase 0 requires of a fresh corpus arc since 1.0.0-dev.11. */
const TEXT_LANE = { ...SLUG_LANE, id: 'text-journey', argv: ['node', '--test', 'test/text.test.js'], testPaths: ['test/text.test.js'] } as const;
const TEXT_WITNESS = { lane: TEXT_LANE.id, testIds: ['words splits on runs of whitespace'], files: ['test/text.test.js'] };

test('upgrade.dev20.checkpoint-reentry-with-fixes: a holistic arc whose checkpoint the previous release ran re-entered page-id, naming the failure it fixes, finishes on HEAD: the bundle\'s re-entry stays in force, HEAD\'s final checkpoint reads the applied answer as recorded, and a later apply is accepted', T, async () => {
  const c = clean();
  const [prev, prevTypes] = await Promise.all([
    loadFrom<PreviousHelpers>(DEV20_RELEASE, 'test', 'helpers', 'holistic.ts'), loadFrom<PreviousTypes>(DEV20_RELEASE, 'src', 'holistic', 'types.ts'),
  ]);
  // page-id's second plan-check (the escalation seat's infeasible) is the failure its park recorded last.
  const fixes = 'page-id/plan-check#2';
  const reenter = { op: 'reenter', unit: REENTRY, reenters: 'page-id', enterAt: null, reset: null, fixes, cites: ['V-1'], evidence: ['page-id parked infeasible: it starts over'] };
  // The redesign the retry runs under: the re-entry's spec gains a fact.
  const respec = { op: 'patch-spec', unit: REENTRY, patch: [{ op: 'add', section: 'facts', item: REENTRY_FACT }], cites: ['V-1'], evidence: ['contract one is satisfiable as written'] };
  // Once holistic, page-id's park has a checkpoint (ckpt-1, the re-entry); the opt-in's drift audit (audit-1, which the
  // bundle's revision joins) finds nothing new after ckpt-1 settled, so it has no checkpoint (`checkpoint-skipped`).
  const p = await preparePrevious([...c.slug, INFEASIBLE, INFEASIBLE, c.pageId.planCheck], [
    midBuild(pageIdFiles(c)),
    prev.checkpointStep('ckpt-1', prev.checkpointAnswer({ decision: 'bundle', ops: [reenter, respec] })),
    prev.lensStep('audit-1', 'invariants'),
  ], () => {}, DEV20_RELEASE);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await until('page-id parks infeasible', PHASE_MS, () => (journalOf(p).view.unit(unitId('page-id')).status === 'park-pending' ? true : null));
    // The architect opts in through the previous release's CLI, the obligations as it wrote them.
    writeFileSync(join(p.l.input, 'vision.json'), `${JSON.stringify(VISION, null, 2)}\n`);
    const file = obligations(laneAs(DEV20_RELEASE, SLUG_LANE), SLUG_WITNESS, (o) => prevTypes.laneRevOf(prevTypes.parseObligations(o).lanes[0]!));
    writeFileSync(join(p.l.input, 'obligations.json'), `${JSON.stringify(file, null, 2)}\n`);
    editJson<object>(p.l.plan, (plan) => ({ ...plan, holistic: { vision: 'vision.json', advances: ['V-1', 'V-2'], obligations: 'obligations.json', audit: { lenses: ['invariants'] } } }));
    await submitOnPrevious(p, ['apply', '--vision-edit']);
    await midCall(p);
    // The park checkpoint and the drift audit run side by side. Every audit started by then (the bundle's revision's
    // drift included) has ended and every checkpoint settled.
    await until('the previous release ends its audits and settles their checkpoints', PHASE_MS, () => {
      const h = journalOf(p).view.holistic();
      const settled = h.audits.length > 0 && h.audits.every((a) => a.ended !== null) && h.checkpoints.every((ck) => ck.decided !== null);
      return settled ? true : null;
    });
    await ackOpenItems(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const failed = mid.unit(unitId('page-id')).failures.at(-1)!.fact;
  assert.equal(`page-id/${failed.stage}#${failed.attempt}`, fixes, 'the re-entry names the failure page-id\'s park recorded');
  const h = mid.holistic();
  assert.deepEqual(h.checkpoints.map((ck) => [ck.inputs.job, ck.inputs.trigger.type, ck.decided?.kind]), [['ckpt-1', 'park', 'applied']], 'the park checkpoint re-entered page-id');
  assert.deepEqual(factsOf(journalOf(p).events, 'checkpoint-skipped').map((k) => k.audit), ['audit-1'], 'the drift audit found nothing new: no checkpoint');
  assert.deepEqual(h.audits.map((a) => a.started.job), ['audit-1']);
  const held = mid.unit(unitId(REENTRY));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['build', 'held', 'interrupted']);
  assert.deepEqual(requirePlanInForce(absPath(p.l.runDir), mid).plan.units.find((u) => u.id === REENTRY)?.reenters, { unit: unitId('page-id'), fixes }, 'the bundle\'s re-entry names the failure it fixes');
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] }, 'default'),
    lensStep('audit-2', 'invariants'), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {}, 'fake-head', [], ['checkpoint-skipped.trigger']);
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal([...hostLogs(p).matchAll(/roadmap: upgrade default \(checkpoint-skipped\.trigger\)/g)].length, 1, 'the older audit-only skip warns once, and reads as its audit trigger');
  assert.equal(r.view.unit(unitId(REENTRY)).status, 'retired', 'HEAD merged the re-entry');
  assert.deepEqual(factsOf(r.after, 'plan-applied'), [], 'HEAD\'s start found the previous release\'s revision in force');
  assert.ok(factsOf(r.after, 'witnessed').some((w) => w.for.type === 'candidate' && w.for.unit === REENTRY), 'the brake ran on the re-entry\'s candidate');
  assert.deepEqual(factsOf(r.after, 'audit-started').map((a) => [a.job, a.triggers.map((t) => t.type)]), [['audit-2', ['final']]]);
  assert.deepEqual(factsOf(r.after, 'bundle-decided').map((b) => [b.job, b.outcome]), [['ckpt-2', { kind: 'no-op' }]]);
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
  assert.doesNotMatch(hostLogs(p), /roadmap: upgrade default \(checkpoint\.reenter\.fixes\)/, 'HEAD\'s checkpoint read the applied answer as recorded: no default');
  // The architect's next apply classifies the plan holding the bundle's re-entry: accepted.
  newDirection(p.l);
  const dry = await headCli(p, ['apply', '--dry-run', ...p.run]);
  assert.equal(dry.code, 0, dry.stderr);
  const out = JSON.parse(dry.stdout) as { kind: string; changes: unknown[] };
  assert.deepEqual([out.kind, out.changes], ['accepted', [{ type: 'plan-field', field: 'direction' }]], dry.stdout);
});

/** A module big enough (about 160 KB) that slug's publication alone outgrows a lens's diff budget. */
const BULK = Array.from({ length: 6000 }, (_, i) => `export const word${i} = 'w${i}';`).join('\n');


// ---------------------------------------------------------------------------------------------------
// A corpus arc the previous release started: its obligations declare their testPaths and witness files

/**
 * The M1 fixture as a corpus arc of `release` (its corpus target: pin, Phase-0 record, fake forge, whose `gh` is in the
 * returned bin dir), its one obligation witnessed through `lane` (as `release` declares it, `laneAs`) by `witness` on the fixture's initial text tests (green
 * from the baseline), L = {invariants}; `m1` and `extra(helpers)` (the release's holistic step builders) its fake steps,
 * after the pack review `review-1`.
 */
async function corpusArc(
  m1: readonly M1Step[], extra: (prev: PreviousHelpers) => readonly Step[], release: Release = PREVIOUS_RELEASE, lane: Readonly<{ cadence: 'build' }> = TEXT_LANE, witness: object = TEXT_WITNESS,
  planExtra: Readonly<Record<string, unknown>> = {},
): Promise<Readonly<{ p: Phase1; gh: string }>> {
  type Target = typeof import('../fixtures/corpus-target.ts');
  type Brake = typeof import('../fixtures/brake-common.ts');
  const load = <M>(...path: string[]): Promise<M> => loadFrom<M>(release, ...path);
  const [prev, prevTypes, target, brake] = await Promise.all([
    load<PreviousHelpers>('test', 'helpers', 'holistic.ts'), load<PreviousTypes>('src', 'holistic', 'types.ts'), load<Target>('test', 'fixtures', 'corpus-target.ts'),
    load<Brake>('test', 'fixtures', 'brake-common.ts'),
  ]);
  let gh = '';
  const p = await preparePrevious(m1, [...extra(prev), prev.packReviewStep('review-1')], (l) => {
    gh = join(l.dir, 'bin-gh');
    mkdirSync(gh, { recursive: true });
    const file = obligations(laneAs(release, lane), witness, (o) => prevTypes.laneRevOf(prevTypes.parseObligations(o).lanes[0]!)) as Record<string, unknown>;
    target.corpusTarget(
      { arc: l.arc, repo: l.repo, planPath: l.plan, runDir: l.runDir, hostDir: join(l.fake, 'host'), binDir: gh, scenarioPath: '', scenarioDir: '' },
      { obligations: file, advances: brake.ADVANCES, audit: { lenses: ['invariants'] }, planExtra },
    );
    // The integration branch starts at the corpus baseline.
    git(l.repo, 'branch', '-f', 'integration', 'main');
  }, release);
  return { p, gh };
}

/** PATH with the corpus arc's `gh` and the previous release's fakes first. */
const corpusPath = (p: Phase1, gh: string): string => [gh, join(p.fakeDir, 'bin'), process.env['PATH'] ?? ''].join(':');

test('upgrade.corpus-witnesses-declared: a corpus arc the previous release started (its arc lane\'s testPaths, its witness\'s files) finishes on HEAD, and an apply\'s Phase 0 checks both as declared: accepted, no default read', T, async () => {
  const c = clean();
  const { p, gh } = await corpusArc([...c.slug, c.pageId.planCheck], () => [midBuild(pageIdFiles(c))]);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p, { PATH: corpusPath(p, gh) });
    await midCall(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const held = mid.unit(unitId('page-id'));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['build', 'held', 'interrupted']);
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] }, 'default'),
    lensStep('audit-1', 'invariants'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {}, 'fake-head', [gh]);
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal(r.view.unit(unitId('page-id')).status, 'retired');
  assert.deepEqual(factsOf(r.after, 'plan-applied'), [], 'HEAD\'s start found the previous release\'s revision in force');
  assert.ok(factsOf(r.after, 'witnessed').some((w) => w.for.type === 'candidate' && w.for.unit === 'page-id'), 'the brake ran on page-id\'s candidate');
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
  newDirection(p.l);
  const dry = await runUntilExit(process.execPath, [fixture('exec-cli.ts'), p.host, 'apply', '--dry-run', ...p.run], {
    env: { ...process.env, PATH: [gh, process.env['PATH'] ?? ''].join(':') }, timeoutMs: CLI_MS,
  });
  assert.equal(dry.code, 0, dry.stderr);
  const out = JSON.parse(dry.stdout) as { kind: string; changes: unknown[] };
  assert.deepEqual([out.kind, out.changes], ['accepted', [{ type: 'plan-field', field: 'direction' }]], dry.stdout);
  assert.doesNotMatch(dry.stderr, /roadmap: upgrade default \(obligations\./, 'the apply read the declared obligations as written');
});

test('upgrade.dev16.plan-check-by-builder: a corpus arc dev.16 started under `planCheck.shape: by-builder` finishes on HEAD, which reads the plan as uniform and warns (dev.17 removed the shape)', T, async () => {
  const c = clean();
  // page-id is at risk med on the efficient builder, so dev.16 plan-checked it in the acceptance shape (a call).
  const { p, gh } = await corpusArc([...c.slug, c.pageId.planCheck], () => [midBuild(pageIdFiles(c))], DEV16_RELEASE, TEXT_LANE, TEXT_WITNESS, { planCheck: { shape: 'by-builder' } });
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p, { PATH: corpusPath(p, gh) });
    await midCall(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const held = journalOf(p).view.unit(unitId('page-id'));
  assert.deepEqual([held.stage, held.status], ['build', 'held']);
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);
  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] }, 'default'),
    lensStep('audit-1', 'invariants'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {}, 'fake-head', [gh], ['plan.planCheck.shape']);
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal(r.view.unit(unitId('page-id')).status, 'retired');
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
  assert.match(hostLogs(p), /roadmap: upgrade default \(plan\.planCheck\.shape\)/, 'HEAD read the plan\'s by-builder shape as uniform, with a warning');
});

test('upgrade.dev16.spec-design-pins: dev.16\'s specs read on HEAD with no design record (kind module, warned) and no revision pins (every link unpinned, a lasting state, unwarned)', async () => {
  const dir = join(tmpDir('upgrade-spec'), 'fx');
  const setup = await runUntilExit(process.execPath, [join(previousOf(DEV16_RELEASE).root, 'evals', 'm1', 'setup.ts'), dir], { env: process.env, timeoutMs: CLI_MS });
  assert.equal(setup.code, 0, setup.stderr);
  const l = layout(dir);
  const warned: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => { warned.push(String(chunk)); return write(chunk, ...rest); }) as typeof process.stderr.write;
  try {
    for (const unit of UNITS) {
      const spec = loadSpec(absPath(join(l.input, `${unit}.json`)));
      assert.equal(spec.design, undefined, `${unit}: dev.16 wrote no design record`);
      assert.equal(specKindOf(spec), 'module');
      assert.equal(specPinOf(spec, { type: 'requirement', id: obligationId('I-1') }), UNPINNED);
      assert.equal(specPinOf(spec, { type: 'contract', path: repoPath('docs/contract.md') }), UNPINNED);
    }
  } finally {
    process.stderr.write = write;
  }
  const kinds = [...warned.join('').matchAll(/roadmap: upgrade default \(([^)]+)\)/g)].map((m) => m[1]!);
  assert.ok(kinds.includes('spec.design.kind'), 'the absent design record was warned');
  assert.ok(!kinds.some((k) => k.startsWith('spec.pins')), 'absent pins are a lasting state, not a default');
});

/** A triple no built-in seat binds: what a scaffold seat may hold without moving an m4b arc's rev. */
const OPUS_SENTINEL = { backend: 'claude', model: 'claude-fable-5-1', effort: 'max' } as const;

test('upgrade.dev16.design-pass-adopted: dev.16\'s plan-check answers read on HEAD with no design record (warned), and its role set hashes and seats no scaffold role', async () => {
  // The answers dev.16's M1 fakes give its plan-checks: what its arcs recorded.
  const scenario = JSON.parse(readFileSync(join(previousOf(DEV16_RELEASE).root, 'evals', 'm1', 'scenarios', 'clean.json'), 'utf8')) as { steps: { role: string; answer?: unknown }[] };
  const answers = scenario.steps.filter((s) => s.role === 'planCheck').map((s) => s.answer);
  assert.ok(answers.length > 0);
  const warned: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => { warned.push(String(chunk)); return write(chunk, ...rest); }) as typeof process.stderr.write;
  try {
    for (const a of answers) {
      const out = validatePlanCheckOutput(a);
      assert.equal(designOfAnswer(out), null, 'no design record');
    }
  } finally {
    process.stderr.write = write;
  }
  assert.ok([...warned.join('').matchAll(/roadmap: upgrade default \(([^)]+)\)/g)].some((m) => m[1] === 'plan-check.design'), 'the absent design record was warned');
  // An arc dev.16 started records the m4b role set: no scaffold seat in force, none hashed (its revs as before).
  const adopted = resolveRouting({ ...arcStack('default', null, null), arcRoles: 'm4b' });
  assert.ok(!seatsInForce(adopted).some((s) => s.role === 'scaffold'));
  const { scaffold: _scaffold, ...dev16Roles } = adopted.table;
  assert.equal(routingRevOf(adopted.table, 'none', 'm4b', false), routingRevOf({ ...dev16Roles, scaffold: { low: OPUS_SENTINEL, med: OPUS_SENTINEL, high: OPUS_SENTINEL } }, 'none', 'm4b', false), 'the scaffold seats are not hashed');
  assert.ok(seatsInForce(resolveRouting({ ...arcStack('default', null, null), arcRoles: 'dev17' })).some((s) => s.role === 'scaffold'), 'a dev.17 arc seats it');
});

test('upgrade.checkpoint-answer-unapplied: a park checkpoint\'s answer the previous release recorded but did not apply (it crashed after the call), re-entering page-id with the failure it fixes, is adopted on HEAD: decided from the recorded answer with no new call, applied, the re-entry merged', T, async () => {
  const c = clean();
  // A re-entry of the infeasible park, naming its last failure (the escalation seat's plan-check).
  const fixes = 'page-id/plan-check#2';
  const reenter = { op: 'reenter', unit: REENTRY, reenters: 'page-id', enterAt: null, reset: null, fixes, cites: ['V-1'], evidence: ['page-id parked infeasible: it starts over'] };
  const { p, gh } = await corpusArc([...c.slug, INFEASIBLE, INFEASIBLE], (prev) => [prev.checkpointStep('ckpt-1', prev.checkpointAnswer({ decision: 'bundle', ops: [reenter] }))]);
  await crashPrevious(p, { label: 'checkpoint.after-call', occurrence: 1 }, async () => {}, { PATH: corpusPath(p, gh) });
  const mid = journalOf(p).view;
  assert.ok(mid.unit(unitId('page-id')).failures.length > 0, 'page-id\'s lineage recorded a failure');
  assert.deepEqual(mid.holistic().checkpoints.map((ck) => [ck.inputs.job, ck.inputs.trigger.type, ck.decided]), [['ckpt-1', 'park', null]], 'the park checkpoint answered, undecided');
  assert.equal(requirePlanInForce(absPath(p.l.runDir), mid).plan.units.some((u) => u.id === REENTRY), false);

  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [c.pageId.planCheck, c.pageId.build, c.pageId.gate] }, 'default'),
    // The bundle's drift audit finds nothing new after ckpt-1 settled (no checkpoint: `checkpoint-skipped`); the final
    // audit's checkpoint is ckpt-2.
    lensStep('audit-1', 'invariants'), lensStep('audit-2', 'invariants'), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  const scope = scopeOf(p);
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {
      // The superseded park's escalation item holds the arc open until acknowledged.
      await until('HEAD applies the recorded bundle', PHASE_MS, () => (journalOf(p).view.unit(unitId('page-id')).status === 'superseded' ? true : null));
      for (const n of journalOf(p).view.needsUser().filter((x) => x.blocking && x.ack === null)) await submitOnHead(p, ['ack', n.id]);
    }, 'fake-head', [gh]);
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.deepEqual(r.calls.filter((call) => call.unit === 'ckpt-1'), [], 'HEAD decided ckpt-1 from the recorded answer: no new call, no repair turn');
  const [applied] = factsOf(r.after, 'plan-applied');
  assert.deepEqual(applied?.source, { type: 'bundle', job: 'ckpt-1', admits: [], conversions: [] }, 'HEAD applied the recorded bundle');
  assert.deepEqual(r.view.holistic().checkpoints.find((ck) => ck.inputs.job === 'ckpt-1')?.decided?.kind, 'applied');
  assert.deepEqual(requirePlanInForce(absPath(p.l.runDir), r.view).plan.units.find((u) => u.id === REENTRY)?.reenters, { unit: unitId('page-id'), fixes }, 'the re-entry enters the plan naming the failure it fixes');
  assert.equal(r.view.unit(unitId(REENTRY)).status, 'retired', 'HEAD merged the re-entry');
  assert.deepEqual(factsOf(r.after, 'checkpoint-skipped').map((k) => k.audit), ['audit-1']);
  assert.deepEqual(factsOf(r.after, 'bundle-decided').map((b) => [b.job, b.outcome]), [['ckpt-2', { kind: 'no-op' }]]);
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
  assert.doesNotMatch(hostLogs(p), /roadmap: upgrade default \(checkpoint\.reenter\.fixes\)/, 'the recorded answer read as written: no default');
});

/**
 * The audit story on `release`: a corpus arc (holistic from the start) whose slug publication alone outgrows a lens's
 * diff budget; `release`'s executor dies in the final audit's second chunk (its first chunk read). HEAD finds the same
 * chunks, consumes the recorded first, asks the lost second again as a bounded diff, settles the checkpoint, completes.
 */
async function auditMidChunk(release: Release): Promise<void> {
  const c = clean();
  const [pc, build, gate] = c.slug;
  const bulky: M1Step = { ...build!, acts: (build as Extract<M1Step, { role: 'build' }>).acts.map((a) => (a.type === 'commit' ? { ...a, files: { ...a.files, 'src/words.js': `${BULK}\n` } } : a)) } as M1Step;
  // Slug's diff overflows the gate's budget too: since 1.0.0-dev.12 its gate answers with a cluster map covering every
  // changed path (asReleaseGate drops it for an earlier release, whose gate had none).
  const bulkyGate: M1Step = { ...gate!, answer: { ...((gate as Exclude<M1Step, { role: 'build' }>).answer as object), clusters: [{ id: 'all', paths: ['**'], review: 'close' }] } } as M1Step;
  // Holistic from the start is a corpus arc (the release refuses one without a corpus). Slug's publication
  // alone is the final audit's first chunk; the lens's call on the second (page-id's) parks until its executor is dead.
  const { p, gh } = await corpusArc([pc!, bulky, bulkyGate, c.pageId.planCheck, c.pageId.build, c.pageId.gate], (prev) => [
    prev.lensStep('audit-1', 'invariants'),
    prev.lensStep('audit-1', 'invariants', [], [{ type: 'barrier', name: MID_CALL, timeoutMs: PHASE_MS }]),
  ], release);
  // As a crash (see crashPrevious): the supervisor frozen so nothing of the release recovers, its executor
  // SIGKILLed while the second chunk's call waits; that call is HEAD's recovery's to end (lost).
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p, { PATH: corpusPath(p, gh) });
    process.kill(supervisor.pid, 'SIGSTOP');
    await midCall(p);
    const executor = readOwner(absPath(p.host))?.executor ?? null;
    assert.ok(executor !== null, 'host.owner.json names the executor');
    process.kill(executor.pid, 'SIGKILL');
    await until('the killed executor is gone', 60_000, () => (isAlive(executor) ? null : true));
    process.kill(supervisor.pid, 'SIGKILL');
    await until('the frozen supervisor is gone', 60_000, () => (isAlive(supervisor) ? null : true));
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.deepEqual(UNITS.map((u) => mid.unit(unitId(u)).status), ['retired', 'retired']);
  const audits = mid.holistic().audits;
  assert.deepEqual(audits.map((a) => [a.started.job, a.started.triggers.map((t) => t.type), a.ended]), [['audit-1', ['final'], null]], 'the final audit is open');
  const lensCalls = (events: readonly Event[]) => events.filter((e) => e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'arc-backend' && e.expect.subject.role === 'lens');
  assert.equal(lensCalls(journalOf(p).events).length, 2, `${release.version} read the first chunk and died in the second`);

  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [] }, 'default'), lensStep('audit-1', 'invariants', [], [], ['<orientation>']), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {}, 'fake-head', [gh]);
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal(lensCalls(r.after).length, 1, 'HEAD consumed the recorded first chunk and asked the lost second once, as a bounded diff');
  const [ended] = factsOf(r.after, 'audit-ended');
  assert.deepEqual([ended?.job, ended?.outcome], ['audit-1', 'completed']);
  assert.ok(ended!.covered.some((cv) => cv.lens === 'invariants' && cv.to === audits[0]!.started.integrationSha), JSON.stringify(ended!.covered));
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
}

test('upgrade.audit-mid-chunk: the final audit whose executor died during its second chunk resumes on HEAD: the chunks found again, the recorded first chunk consumed, the lost second asked again as a bounded diff, the arc completed', T, async () => {
  await auditMidChunk(PREVIOUS_RELEASE);
});

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.11's arcs (DEV11_RELEASE), the paths dev.12 replaced: a refused read dev.11 voided, a judgment it did not
// persist, an audit it left between chunks (fingerprint-open-ff and routing-stable have their dev.11 cells beside theirs)

/**
 * page-id's gate as `release` plays it, `acts` before its answer (its judgment tools), the answer in that release's shape
 * (asReleaseGate).
 */
const releaseGate = (release: Release, answer: JsonValue, acts: readonly ClaudeAct[] = []): Step => {
  const shaped = asReleaseGate(release, { role: 'gate', answer });
  return { as: 'claude', expect: { argv: ['-p', '--tools', judgmentToolsOf(release)] }, acts: [...acts, { type: 'emit', value: (shaped as Exclude<M1Step, { role: 'build' }>).answer }] };
};
const gateAnswer = (c: Clean): JsonValue => (c.pageId.gate as Exclude<M1Step, { role: 'build' }>).answer;

test('upgrade.dev11.read-denied-retry: a gate approve dev.11 voided as read-denied, crashed before its retry, takes that retry on HEAD by the old row (uncharged) and merges', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build], [releaseGate(DEV11_RELEASE, gateAnswer(c), [{ type: 'globAboveAddDir' }])], undefined, DEV11_RELEASE);
  // page-id's stages: plan-check, build, quiesce, evidence, salvage, teardown, lanes, then the gate (the eighth).
  await crashPrevious(p, { label: 'unit.after-stage', occurrence: 8, unit: 'page-id' });
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  assert.equal(outcomesOf(journalOf(p).events, 'page-id').at(-1), 'gate:read-denied', 'dev.11 voided the approve');
  assert.equal(mid.unit(unitId('page-id')).approval, null);
  assert.deepEqual(mid.needsUser(), [], 'the retry is pending: no park');

  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.deepEqual(outcomesOf(f.after, 'page-id').slice(0, 1), ['gate:approve'], 'HEAD re-ran the gate by the read-denied row and approved');
  assert.equal(f.view.unit(unitId('page-id')).counters.retries.gate, 1, 'the one uncharged retry');
  assert.equal(f.view.unit(unitId('page-id')).counters.chargeableFailures, 0);
});

test('upgrade.dev11.unpersisted-refused: a gate answer off its schema dev.11 received in an unpersisted session, crashed before reading, is read on HEAD with no repair turn (a call consumed after a crash takes none): malformed, then a fresh gate merges', T, async () => {
  const c = clean();
  const offSchema = { decision: 'approve', findings: [], directives: [], reasons: ['B1 holds'] };
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build], [releaseGate(DEV11_RELEASE, offSchema)], undefined, DEV11_RELEASE);
  // page-id's spawns: its plan-check, its resource's probe, its build, the resource's teardown, its lane, then the gate (the sixth).
  await crashPrevious(p, { label: 'spawn.after-done', occurrence: 6, unit: 'page-id' });
  const events = journalOf(p).events;
  const gateSpawns = events.flatMap((e) => (e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'backend' && e.expect.subject.role === 'gate' && e.expect.subject.unit === 'page-id' ? [e] : []));
  assert.equal(gateSpawns.length, 1, 'dev.11 spawned page-id\'s gate once');
  assert.ok(journalOf(p).view.doneOf(gateSpawns[0]!.op) !== null, 'its call is done');
  assert.ok(!outcomesOf(events, 'page-id').some((o) => o.startsWith('gate:')), 'and unread');

  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.deepEqual(outcomesOf(f.after, 'page-id').slice(0, 2), ['gate:malformed', 'gate:approve'], 'the refusal stands, then a fresh gate');
  assert.ok(!f.calls.some((call) => call.argv.includes('--resume')), 'no repair turn');
});

test('upgrade.dev11.audit-mid-chunk: the final audit dev.11 left in its second chunk (its lens calls attaching the diff, not the bounded diff) resumes on HEAD: the chunks found again, the recorded first chunk consumed, the lost second asked again as a bounded diff, the arc completed', T, async () => {
  await auditMidChunk(DEV11_RELEASE);
});

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.10's arcs (DEV10_RELEASE): what dev.10 lacks of dev.11 reads with the defaults of src/core/upgrade.ts

/** An arc lane and witness as 1.0.0-dev.10 wrote them: no `testPaths`, no `files` (it had neither). */
const UNDECLARED_TEXT_LANE = { ...SLUG_LANE, id: 'text-journey', argv: ['node', '--test', 'test/text.test.js'] } as const;
const UNDECLARED_TEXT_WITNESS = { lane: UNDECLARED_TEXT_LANE.id, testIds: ['words splits on runs of whitespace'] };

/** The architect re-enters `page-id` as REENTRY (its spec and scope) as on dev.10: with no `fixes`, which it had not. */
function reenterPageIdBeforeFixes(l: Layout): void {
  type Unit = { id: string; spec: string };
  const spec = JSON.parse(readFileSync(join(l.input, 'page-id.json'), 'utf8')) as object;
  writeFileSync(join(l.input, `${REENTRY}.json`), `${JSON.stringify({ ...spec, unit: REENTRY, rev: 1 }, null, 2)}\n`);
  editJson<{ units: Unit[] }>(l.plan, (plan) => {
    const old = plan.units.find((u) => u.id === 'page-id')!;
    return { ...plan, units: [...plan.units, { ...old, id: REENTRY, spec: `${REENTRY}.json`, reenters: { unit: 'page-id' } }] };
  });
}

test('upgrade.dev10.apply-queued: an apply dev.10\'s CLI queues (`expectRev`, no `base`, no `visionEdit`) on HEAD\'s running arc is rebased from the default base and applied as revision 2, its bytes unchanged', T, async () => {
  // page-id stays held until the apply lands: an arc-scoped apply waits for every unit to be idle. The edit is made
  // on the running arc, so HEAD's start finds the files in force and the revision is the command's.
  const { p, head } = await stoppedMidBuild(clean(), undefined, false, [], DEV10_RELEASE);
  let id = '';
  let queued: Buffer | null = null;
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head, async () => {
      await until('HEAD\'s executor runs the arc', PHASE_MS, () => (factsOf(journalOf(p).events, 'executor-started').length > 1 ? true : null));
      newDirection(p.l);
      id = await submitOnPrevious(p, ['apply']);
      queued = commandBytes(p, id);
      await submitOnHead(p, ['resume', 'page-id']);
    });
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const body = (JSON.parse(queued!.toString('utf8')) as { body: Readonly<Record<string, unknown>> }).body;
  assert.deepEqual([body['type'], 'expectRev' in body, 'base' in body, 'visionEdit' in body], ['apply', true, false, false], 'dev.10\'s CLI queued the apply it knew');
  const [fact, ...more] = factsOf(f.after, 'plan-applied');
  assert.ok(fact !== undefined && more.length === 0);
  assert.deepEqual([fact.rev, fact.command, fact.changes], [2, id, [{ type: 'plan-field', field: 'direction' }]]);
  assert.ok(queued !== null && commandBytes(p, id).equals(queued), 'dev.10\'s command file is never rewritten');
  assert.match(hostLogs(p), /roadmap: upgrade default \(apply\.expectRev\)/, 'HEAD read the command\'s expectRev as the default base, with a warning');
});

test('upgrade.dev10.vision-edit-queued: the opt-in apply dev.10\'s CLI queues (no `visionEdit` field: its CLI had no flag) changes the vision and is adopted as a declared vision edit, never refused as vision-leak; the default warned', T, async () => {
  let body: Readonly<Record<string, unknown>> = {};
  const { p } = await optInHolistic(async (q) => {
    const id = await submitOnPrevious(q, ['apply']);
    body = (JSON.parse(commandBytes(q, id).toString('utf8')) as { body: Readonly<Record<string, unknown>> }).body;
    return id;
  }, DEV10_RELEASE);
  assert.deepEqual([body['type'], 'expectRev' in body, 'visionEdit' in body], ['apply', true, false], 'dev.10\'s CLI queued no visionEdit');
  assert.match(hostLogs(p), /roadmap: upgrade default \(apply\.visionEdit\)/, 'HEAD read the absent field as a declared vision edit, with a warning');
});

test('upgrade.dev10.reentry-before-fixes: a re-entry dev.10 applied without `fixes` over a lineage with a recorded failure stays in force on HEAD, never classified again: HEAD finishes it, and a later apply is accepted', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, INFEASIBLE, INFEASIBLE, c.pageId.planCheck], [midBuild(pageIdFiles(c))], undefined, DEV10_RELEASE);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await until('page-id parks infeasible', PHASE_MS, () => (journalOf(p).view.unit(unitId('page-id')).status === 'park-pending' ? true : null));
    reenterPageIdBeforeFixes(p.l);
    await submitOnPrevious(p, ['apply']);
    await midCall(p);
    await ackOpenItems(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  assert.ok(mid.unit(unitId('page-id')).failures.length > 0, 'page-id\'s lineage recorded a failure: a re-entry added now must name it in `fixes`');
  const held = mid.unit(unitId(REENTRY));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['build', 'held', 'interrupted']);
  const inForce = requirePlanInForce(absPath(p.l.runDir), mid).plan.units.find((u) => u.id === REENTRY);
  assert.deepEqual(inForce?.reenters, { unit: unitId('page-id') }, 'the re-entry in force names no failure');
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  const steps = headFakeSteps({ steps: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] }, 'default');
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {});
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal(r.view.unit(unitId(REENTRY)).status, 'retired', 'HEAD merged the re-entry');
  assert.deepEqual(factsOf(r.after, 'plan-applied'), [], 'HEAD\'s start found dev.10\'s revision in force');
  newDirection(p.l);
  const dry = await headCli(p, ['apply', '--dry-run', ...p.run]);
  assert.equal(dry.code, 0, dry.stderr);
  const out = JSON.parse(dry.stdout) as { kind: string; changes: unknown[] };
  assert.deepEqual([out.kind, out.changes], ['accepted', [{ type: 'plan-field', field: 'direction' }]], dry.stdout);
});

test('upgrade.dev10.written-back-inputs: the owner\'s files dev.10 wrote back (a plan-check\'s spec patch, a ruling\'s ledger line and sidecar) rebase cleanly on HEAD: its start and an architect apply take them as in force, and HEAD writes nothing into them', T, async () => {
  const c = clean();
  const redirect: M1Step = { role: 'planCheck', answer: { ...((c.pageId.planCheck as Exclude<M1Step, { role: 'build' }>).answer as object), decision: 'redirect', patch: [{ op: 'add', section: 'facts', item: REDIRECT_FACT }] } };
  const p = await preparePrevious([...c.slug, redirect, c.pageId.planCheck], [midBuild(pageIdFiles(c))], undefined, DEV10_RELEASE);
  const ledger = join(p.l.input, 'rulings.md');
  const sidecar = join(`${ledger}.d`, `${RULING}.json`);
  const specPath = join(p.l.input, 'page-id.json');
  const ledgerBefore = readFileSync(ledger);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await midCall(p);
    const file = join(p.dir, 'C-3.json');
    writeFileSync(file, `${JSON.stringify(rulingRecord(p, ledgerBefore), null, 2)}\n`);
    await submitOnPrevious(p, ['rule', file]);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  // What dev.10 wrote back into the owner's files.
  const writtenLedger = readFileSync(ledger);
  assert.equal(writtenLedger.toString('utf8'), `${ledgerBefore.toString('utf8')}${RULING} — ${RULING_TEXT}\n`, 'dev.10 wrote its ruling into the ledger');
  assert.ok(existsSync(sidecar), 'and its sidecar beside it');
  const writtenSidecar = readFileSync(sidecar);
  const writtenSpec = readFileSync(specPath);
  const spec = JSON.parse(writtenSpec.toString('utf8')) as { rev: number; facts: { id: string }[] };
  assert.deepEqual([spec.rev, spec.facts.some((x) => x.id === REDIRECT_FACT.id)], [2, true], 'dev.10 wrote the plan-check\'s patch into page-id\'s spec');
  assert.equal(journalOf(p).view.planApplied()?.rev, 2, 'the ruling\'s revision');

  let id = '';
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate], async () => {
      await until('HEAD\'s executor runs the arc', PHASE_MS, () => (factsOf(journalOf(p).events, 'executor-started').length > 1 ? true : null));
      newDirection(p.l);
      id = await submitOnHead(p, ['apply']);
      await submitOnHead(p, ['resume', 'page-id']);
    });
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const [fact, ...more] = factsOf(f.after, 'plan-applied');
  assert.ok(fact !== undefined && more.length === 0, 'HEAD\'s start found the files in force: only the apply revised the plan');
  assert.deepEqual([fact.rev, fact.command, fact.changes, fact.rulingsSha256], [3, id, [{ type: 'plan-field', field: 'direction' }], bytesSha256(writtenLedger)]);
  assert.equal(f.view.unit(unitId('page-id')).spec?.rev, 2, 'page-id merged at the patched rev');
  assert.ok(readFileSync(ledger).equals(writtenLedger) && readFileSync(sidecar).equals(writtenSidecar) && readFileSync(specPath).equals(writtenSpec), 'HEAD wrote nothing into the owner\'s files');
  const constraints = git(p.l.repo, 'show', 'integration:.roadmap/constraints.md');
  assert.equal(constraints.split(`${RULING} — ${RULING_TEXT}`).length - 1, 1, 'C-3 published once');
});

test('upgrade.dev10.checkpoint-reentry-before-fixes: a holistic arc whose checkpoint dev.10 ran re-entered page-id without `fixes` finishes on HEAD: the bundle\'s re-entry stays in force, HEAD\'s final checkpoint reads the applied answer with the default, and a later apply is accepted', T, async () => {
  const c = clean();
  const [prev, prevTypes] = await Promise.all([
    loadFrom<PreviousHelpers>(DEV10_RELEASE, 'test', 'helpers', 'holistic.ts'), loadFrom<PreviousTypes>(DEV10_RELEASE, 'src', 'holistic', 'types.ts'),
  ]);
  const reenter = { op: 'reenter', unit: REENTRY, reenters: 'page-id', enterAt: null, reset: null, cites: ['V-1'], evidence: ['page-id parked infeasible: it starts over'] };
  // Once holistic, page-id's park has a checkpoint (ckpt-1, the re-entry); the opt-in's drift audit (audit-1, which the
  // bundle's revision joins) and, on dev.10, its checkpoint (ckpt-2, no-op).
  const p = await preparePrevious([...c.slug, INFEASIBLE, INFEASIBLE, c.pageId.planCheck], [
    midBuild(pageIdFiles(c)),
    prev.checkpointStep('ckpt-1', prev.checkpointAnswer({ decision: 'bundle', ops: [reenter] })),
    prev.lensStep('audit-1', 'invariants'),
    prev.checkpointStep('ckpt-2', prev.checkpointAnswer({ decision: 'no-op' })),
  ], undefined, DEV10_RELEASE);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await until('page-id parks infeasible', PHASE_MS, () => (journalOf(p).view.unit(unitId('page-id')).status === 'park-pending' ? true : null));
    // The architect opts in through dev.10's CLI, the obligations as it wrote them.
    writeFileSync(join(p.l.input, 'vision.json'), `${JSON.stringify(VISION, null, 2)}\n`);
    const file = obligations(laneAs(DEV10_RELEASE, SLUG_LANE), SLUG_WITNESS, (o) => prevTypes.laneRevOf(prevTypes.parseObligations(o).lanes[0]!));
    writeFileSync(join(p.l.input, 'obligations.json'), `${JSON.stringify(file, null, 2)}\n`);
    editJson<object>(p.l.plan, (plan) => ({ ...plan, holistic: { vision: 'vision.json', advances: ['V-1', 'V-2'], obligations: 'obligations.json', audit: { lenses: ['invariants'] } } }));
    await submitOnPrevious(p, ['apply']);
    await midCall(p);
    // The park checkpoint and the drift audit run side by side; the audit's own checkpoint follows it. Every audit
    // started by then (the bundle's revision's drift included) has ended and its checkpoint settled.
    await until('dev.10 ends its audits and settles their checkpoints', PHASE_MS, () => {
      const h = journalOf(p).view.holistic();
      const audited = new Set(h.checkpoints.flatMap((ck) => (ck.inputs.trigger.type === 'audit' ? [ck.inputs.trigger.job] : [])));
      const settled = h.audits.length > 0 && h.audits.every((a) => a.ended !== null && audited.has(a.started.job)) && h.checkpoints.every((ck) => ck.decided !== null);
      return settled ? true : null;
    });
    await ackOpenItems(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  assert.ok(mid.unit(unitId('page-id')).failures.length > 0, 'page-id\'s lineage recorded a failure');
  const h = mid.holistic();
  assert.deepEqual(h.checkpoints.map((ck) => [ck.inputs.job, ck.inputs.trigger.type, ck.decided?.kind]), [['ckpt-1', 'park', 'applied'], ['ckpt-2', 'audit', 'no-op']], 'the park checkpoint re-entered page-id; the drift audit\'s checkpoint changed nothing');
  assert.deepEqual(h.audits.map((a) => a.started.job), ['audit-1']);
  const held = mid.unit(unitId(REENTRY));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['build', 'held', 'interrupted']);
  assert.deepEqual(requirePlanInForce(absPath(p.l.runDir), mid).plan.units.find((u) => u.id === REENTRY)?.reenters, { unit: unitId('page-id') }, 'the bundle\'s re-entry names no failure');
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] }, 'default'),
    lensStep('audit-2', 'invariants'), checkpointStep('ckpt-3', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {});
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal(r.view.unit(unitId(REENTRY)).status, 'retired', 'HEAD merged the re-entry');
  assert.deepEqual(factsOf(r.after, 'plan-applied'), [], 'HEAD\'s start found dev.10\'s revision in force');
  assert.ok(factsOf(r.after, 'witnessed').some((w) => w.for.type === 'candidate' && w.for.unit === REENTRY), 'the brake ran on the re-entry\'s candidate');
  assert.deepEqual(factsOf(r.after, 'audit-started').map((a) => [a.job, a.triggers.map((t) => t.type)]), [['audit-2', ['final']]]);
  assert.deepEqual(factsOf(r.after, 'bundle-decided').map((b) => [b.job, b.outcome]), [['ckpt-3', { kind: 'no-op' }]]);
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
  assert.match(hostLogs(p), /roadmap: upgrade default \(checkpoint\.reenter\.fixes\)/, 'HEAD\'s checkpoint read the applied answer\'s re-entry as naming no failure, and warned');
  // The architect's next apply classifies the plan holding the bundle's re-entry: accepted.
  newDirection(p.l);
  const dry = await headCli(p, ['apply', '--dry-run', ...p.run]);
  assert.equal(dry.code, 0, dry.stderr);
  const out = JSON.parse(dry.stdout) as { kind: string; changes: unknown[] };
  assert.deepEqual([out.kind, out.changes], ['accepted', [{ type: 'plan-field', field: 'direction' }]], dry.stdout);
});

test('upgrade.dev10.corpus-witnesses-undeclared: a corpus arc dev.10 started (its arc lane without testPaths, its witness without files) finishes on HEAD, and an apply\'s Phase 0 reads both as undeclared: unchecked, warned, accepted', T, async () => {
  const c = clean();
  const { p, gh } = await corpusArc([...c.slug, c.pageId.planCheck], () => [midBuild(pageIdFiles(c))], DEV10_RELEASE, UNDECLARED_TEXT_LANE, UNDECLARED_TEXT_WITNESS);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p, { PATH: corpusPath(p, gh) });
    await midCall(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const held = mid.unit(unitId('page-id'));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['build', 'held', 'interrupted']);
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] }, 'default'),
    lensStep('audit-1', 'invariants'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {}, 'fake-head', [gh]);
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal(r.view.unit(unitId('page-id')).status, 'retired');
  assert.deepEqual(factsOf(r.after, 'plan-applied'), [], 'HEAD\'s start found dev.10\'s revision in force');
  assert.ok(factsOf(r.after, 'witnessed').some((w) => w.for.type === 'candidate' && w.for.unit === 'page-id'), 'the brake ran on page-id\'s candidate');
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
  newDirection(p.l);
  const dry = await runUntilExit(process.execPath, [fixture('exec-cli.ts'), p.host, 'apply', '--dry-run', ...p.run], {
    env: { ...process.env, PATH: [gh, process.env['PATH'] ?? ''].join(':') }, timeoutMs: CLI_MS,
  });
  assert.equal(dry.code, 0, dry.stderr);
  const out = JSON.parse(dry.stdout) as { kind: string; changes: unknown[] };
  assert.deepEqual([out.kind, out.changes], ['accepted', [{ type: 'plan-field', field: 'direction' }]], dry.stdout);
  for (const kind of ['obligations.lanes.testPaths', 'obligations.witness.files']) {
    assert.ok(dry.stderr.includes(`roadmap: upgrade default (${kind})`), `the apply read the obligations with the ${kind} default, and warned: ${dry.stderr}`);
  }
});

test('upgrade.dev10.checkpoint-answer-unapplied: a park checkpoint\'s answer dev.10 recorded but did not apply (it crashed after the call), re-entering page-id without `fixes` and changing nothing, is adopted on HEAD: decided from the recorded answer with no new call, applied, the re-entry merged', T, async () => {
  const c = clean();
  // A bare re-entry of the infeasible park: HEAD refuses it from an answer of its own (no `fixes`).
  const reenter = { op: 'reenter', unit: REENTRY, reenters: 'page-id', enterAt: null, reset: null, cites: ['V-1'], evidence: ['page-id parked infeasible: it starts over'] };
  const { p, gh } = await corpusArc(
    [...c.slug, INFEASIBLE, INFEASIBLE], (prev) => [prev.checkpointStep('ckpt-1', prev.checkpointAnswer({ decision: 'bundle', ops: [reenter] }))],
    DEV10_RELEASE, UNDECLARED_TEXT_LANE, UNDECLARED_TEXT_WITNESS,
  );
  await crashPrevious(p, { label: 'checkpoint.after-call', occurrence: 1 }, async () => {}, { PATH: corpusPath(p, gh) });
  const mid = journalOf(p).view;
  assert.ok(mid.unit(unitId('page-id')).failures.length > 0, 'page-id\'s lineage recorded a failure');
  assert.deepEqual(mid.holistic().checkpoints.map((ck) => [ck.inputs.job, ck.inputs.trigger.type, ck.decided]), [['ckpt-1', 'park', null]], 'the park checkpoint answered, undecided');
  assert.equal(requirePlanInForce(absPath(p.l.runDir), mid).plan.units.some((u) => u.id === REENTRY), false);

  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [c.pageId.planCheck, c.pageId.build, c.pageId.gate] }, 'default'),
    // The bundle's drift audit finds nothing new after ckpt-1 settled (no checkpoint: `checkpoint-skipped`); the final
    // audit's checkpoint is ckpt-2.
    lensStep('audit-1', 'invariants'), lensStep('audit-2', 'invariants'), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  const scope = scopeOf(p);
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {
      // The superseded park's escalation item holds the arc open until acknowledged.
      await until('HEAD applies the recorded bundle', PHASE_MS, () => (journalOf(p).view.unit(unitId('page-id')).status === 'superseded' ? true : null));
      for (const n of journalOf(p).view.needsUser().filter((x) => x.blocking && x.ack === null)) await submitOnHead(p, ['ack', n.id]);
    }, 'fake-head', [gh]);
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.deepEqual(r.calls.filter((call) => call.unit === 'ckpt-1'), [], 'HEAD decided ckpt-1 from the recorded answer: no new call, no repair turn');
  const [applied] = factsOf(r.after, 'plan-applied');
  assert.deepEqual(applied?.source, { type: 'bundle', job: 'ckpt-1', admits: [], conversions: [] }, 'HEAD applied the recorded bundle');
  assert.deepEqual(r.view.holistic().checkpoints.find((ck) => ck.inputs.job === 'ckpt-1')?.decided?.kind, 'applied');
  assert.deepEqual(requirePlanInForce(absPath(p.l.runDir), r.view).plan.units.find((u) => u.id === REENTRY)?.reenters, { unit: unitId('page-id') }, 'the re-entry enters the plan without fixes');
  assert.equal(r.view.unit(unitId(REENTRY)).status, 'retired', 'HEAD merged the re-entry');
  assert.deepEqual(factsOf(r.after, 'checkpoint-skipped').map((k) => k.audit), ['audit-1']);
  assert.deepEqual(factsOf(r.after, 'bundle-decided').map((b) => [b.job, b.outcome]), [['ckpt-2', { kind: 'no-op' }]]);
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
  assert.match(hostLogs(p), /roadmap: upgrade default \(checkpoint\.reenter\.fixes\)/, 'the default warned');
});

test('upgrade.dev16.result-earlier-reader: an invocation dev.16 adapted (result.json written, its done not) is re-adapted on HEAD to the recorded result, warned, never refused', T, async () => {
  type PrevScenario = { fixtureInvocation: (name: string, child: { type: 'exited'; code: number }) => string };
  type PrevAdapter = { writeResult: (invDir: string) => unknown };
  const [prevScenario, prevAdapter] = await Promise.all([
    loadFrom<PrevScenario>(DEV16_RELEASE, 'test', 'helpers', 'scenario.ts'), loadFrom<PrevAdapter>(DEV16_RELEASE, 'src', 'backends', 'adapter.ts'),
  ]);
  const fieldStream = readFileSync(join(EXECUTOR, 'test', 'fixtures', 'backend-output', 'claude-judgment-usage-limit-subagents', 'stdout'), 'utf8');
  const lines = readFileSync(join(EXECUTOR, 'test', 'fixtures', 'backend-output', 'claude-judgment-subagents', 'stdout'), 'utf8').split('\n').filter((l) => l !== '');
  const cutStream = lines.filter((l) => (JSON.parse(l) as { type: string }).type !== 'result').map((l) => `${l}\n`).join('');
  // The field's usage limit before empty results (dev.17 classifies it from any result) and a judgment killed before its
  // result (dev.17 records what it streamed): dev.16's reader wrote another result for each.
  const warnings: string[] = [];
  for (const stdout of [fieldStream, cutStream]) {
    const invDir = prevScenario.fixtureInvocation('claude-judgment-subagents', { type: 'exited', code: 0 });
    writeFileSync(join(invDir, 'stdout'), stdout);
    prevAdapter.writeResult(invDir);
    const recorded = readFileSync(join(invDir, 'result.json'), 'utf8');
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (warnings.push(String(chunk)), true)) as typeof process.stderr.write;
    let adopted: unknown;
    try {
      adopted = writeResult(invDir);
    } finally {
      process.stderr.write = write;
    }
    assert.equal(readFileSync(join(invDir, 'result.json'), 'utf8'), recorded, 'result.json is kept as written');
    assert.equal(canonicalJson(adopted as JsonValue), canonicalJson(JSON.parse(recorded) as JsonValue), 'the recorded result is the reading');
  }
  assert.equal(warnings.length, 1, warnings.join(''));
  assert.match(warnings[0]!, /roadmap: upgrade default \(result\.earlier-reader\)/, 'warned once');
});
