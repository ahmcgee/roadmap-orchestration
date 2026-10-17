// The unit stages from plan-check through lanes (plan "Pipeline for one serial unit", R3), one function
// per stage. Each starts a new attempt, does its work through journaled ops, records exactly one
// `stage-outcome` fact (`outcomeFact`) and returns the `Next` that `transition` decides from the unit state
// the fold derives. Counters are never kept here: the attempt number and every counter come from
// `JournalView.unit`, so a restart sees exactly what the log says.
//
// Every stage a unit is admitted into takes its entry reservation before its first journaled op (A1, F6):
// plan-check and gate `@cpu`×1 (`judgmentEntry`, held until the call is read), build the unit's resources and
// `@cpu`×`buildCpu` (`buildEntry`, held through the build chain to teardown), lanes its first lane's set
// (lanes.ts `seriesEntry`). The grant's `reserve` transition is the
// attempt's first op, so a wait the task's signal cancels (pause, stop) starts nothing (`Cancelled`): no
// attempt, no counter, no `interrupted`. A judgment journals facts before it (plan-check's pin, and its
// `judgment-inputs` capture, below), which a cancelled wait leaves behind. The chain stages (quiesce → evidence → salvage → teardown) take none
// and ignore the signal. A judgment's inputs are durable before its spawn (`judgment-inputs`, F1).
//
// M3 (A19, H2): a judgment's revision-sensitive inputs (the integration tip, the spec, plan, ledger, vision and
// obligations in force, the prompt rendered from them, a gate's approval fingerprint) are read and its
// `judgment-inputs` written in one synchronous capture under the revision fence (src/core/fence.ts
// `captureUnderFence`), so no judgment reads the window between a docs `ff` and its `plan-applied`. One acquisition
// order (Checkpoint A): the capture comes BEFORE the judgment's `@cpu` entry, so no judgment holds `@cpu` while it
// waits for the fence (a revision holds the fence through its docs publication, whose lanes wait for `@cpu`). A wait
// the signal cancels then leaves only the capture, which the next attempt's replaces. The executor's own spec patches
// (a plan-check redirect, the implementer's decisions) are machine revisions of a spec: each holds the fence
// (`holdFence`) so it serialises with every other revision. Plan-check reads the vision in force as non-directive
// context (R17); the gate never does.
//
// Outcomes are written through the park table (`record`, src/park/table.ts `stageOutcomeFact`): a retryable
// park carries its targets (the call's backend, the host, each instance a cleanup failed), a repeat park is
// operator with an `env-blocked` item, and a hold carries its backend-park cause (G5) or, M4b rev 3 (RC-11), its
// `host-pressure` cause: a call or lane its watchdog ended under host pressure, or a red lane under it (starved.ts).
//
//   plan-check  fresh judgment session → approve | redirect (spec.patch, rev+1) |
//               infeasible | escalate; a redirect may neither lower the risk floor nor widen the unit's
//               envelope, and may cite only plan contracts and ledger rulings; a raised risk re-pins the
//               dispatch record. 2026-10-15: one validator (`judgePlanCheck`: the schema, the cites, the patch
//               through `evaluateRevision`); an answer it refuses is sent back once to the same session with every
//               reason (the repair turn, `--resume`), whose answer is the attempt's. The session reads detached checkouts of the integration tip (its cwd) and
//               of the unit branch when one exists, created for the attempt and removed when it is read. The
//               answer is read against the spec rev its `judgment-inputs` captured; each `visionConflict` opens
//               a P3 `plan-check` finding for the checkpoint (R17, src/holistic/findings.ts), never a redirect.
//               Scope growth (2026-10-15): a proposal code verifies (`verifiedGrowth`) holds the unit `scope-growth`;
//               nothing else of that answer is applied, so its patch is not judged (no repair turn for it), and a
//               pattern code cannot verify is dropped and named, never a reason to refuse the answer.
//   build       the implementer round (rounds.ts) under its entry reservation, held from reserve to
//               teardown; the D4 escalation is decided before the seat (G1); prompt: fast lanes only (the spec's,
//               and the plan's fast suite lanes, `fastSuiteLanes`), the worktree, the evidence dir, the pinned scope,
//               the approving plan-check's notes. A resumed session that never persisted re-runs once, fresh
//               (`callRound`). A resolve round, or the continue of one, must leave the merge-in committed.
//   quiesce     the build invocation's workload is empty (invoke already guarantees it; asserted).
//   evidence    `evidence.snapshot` of the build's stdout, stderr and evidence dir, and the fast lanes'
//               declared outputs in the worktree; then the implementer's decisions.json is appended to
//               the spec's decisions (spec.patch by the executor). A decisions.json that does not validate makes
//               a build that reported success malformed (dev.12): its resume round quotes why.
//   salvage     `salvage.commit` under the pinned scope; a plan contract, the architecture doc or its
//               digest in the unit's merge-base diff is a risk trigger; a merge left in progress parks. A
//               failed salvage cleans the build's reservation, and the instances that cleanup failed join the
//               park's targets (G6).
//   teardown    cleanup of the build's reservation.
//   lanes       lanes.ts in a detached checkout of the salvage SHA; the lane ledger for the gate. M4a rev 3: a plan known
//               defect the unit matches (by lane before any lane runs, by a red lane's output after) is `known-defect`,
//               uncharged, to prepare (F4, `knownDefectHit`); a green certified series then runs the regenerate checks
//               of the derived entries the diff touches and the plan's fast suite lanes (`fastSuite`, below: a red one on
//               the unit's diff base too is `base-red`, uncharged), and in a
//               corpus arc the executable checks: witness presence (witnesscheck.ts, D1) and mutation smoke (smoke.ts,
//               D2). The verification checkout is kept only when the gate is next.
//
// 2026-10-15: a spec in force from a 1.0.0-dev.9 arc whose active witness item names no arc lane parks the unit
// `witness-lane-missing` at build or lanes (`witnessLanePark`): its lane file cannot be published nor its lane run.
//
// Plan defects (2026-10-16): a lanes attempt whose unit's last two salvages both reverted the same out-of-scope path holds
// `scope-growth` before anything runs (`repeatedReverts`), the hold a plan-check's proposal raises, with those paths as
// the one proposal: the builder keeps needing a path its scope lacks, so the root agent decides instead of another fix
// round. Every bound of what a unit may change reads its dispatch record's `effectiveScope` (scope + derived outputs).
//
// M4a rev 3 (E, R55): under `planCheck.shape: by-builder` in a corpus arc with arc lanes (`planCheckShape`), a frontier or
// summit builder's plan-check records `in-session` without a call, and its fresh build makes two invocations in one
// attempt: the assessment (a fresh read-only session answering PLAN_ASSESSMENT_SCHEMA: vision conflicts open findings, a
// raised floor raises the risk or reseats the build, `infeasible` parks) and the build resuming that session; an
// efficient builder's plan-check gets the acceptance shape (witness items through the patch channel, R59). Every build
// call writes its own answer schema (`buildSchemaFor` of the spec's fast lanes, I3) and, in a corpus arc, publishes the
// lane files its witness-check commands read (witnesscheck.ts, R56).
//
// Needs-user content the table does not carry (occupancy detail, a backend park) is returned as
// `needsUser` for the caller to write (step 13 owns the writer). Nothing written here names a model.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { freshJudgmentSession, resumedJudgmentSession } from '../backends/argv.ts';
import {
  BACKEND_PARK_CLASSES, type DiffShown, type GateLargeDiff, type HoldCause, type IntentOf, type JudgmentStage, type OpKind, type OutcomeStage, type ScopeGrowthProposal, type StageOutcomeDetail, type StageOutcomeKind,
} from '../core/events.ts';
import { crashPoint } from '../core/crash.ts';
import { captureUnderFence, holdFence } from '../core/fence.ts';
import { durableMkdir } from '../core/fsx.ts';
import {
  type ImplementerSessionId, type InvocationId, type ObligationId, compareIds, witnessItemIdOf, witnessItemSeq, type JudgmentSessionId, type LaneId, type ResourceInstance, type RoutingRev, type Sha, type Sha256Hex, type SpecRev, type UnitId, invocationId,
} from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import {
  type ApprovalFingerprint, type JudgmentSession, type LaneDef, type SpecM1, type SpecPatchOp, type NeedsUserContent, STDERR_FILE, STDOUT_FILE, effectiveScope, specRemoves,
  specWitnesses,
} from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import {
  type AbsPath, type RefName, type RepoPath, type RepoPattern, absPath, branchRef, gitDate, isoTimeOf, matchesPattern, repoPath, repoPattern,
} from '../core/values.ts';
import { FILES_DIR, capturedEvidence, pathPattern } from '../git/evidence.ts';
import { GitError, type Identity, git, gitRun, refTarget, revParse } from '../git/git.ts';
import { mergeHead, resolvedHead } from '../git/mergein.ts';
import { SalvageStateError, SalvageUnmergedError, checkRejected, planSalvage, type SalvageRules } from '../git/salvage.ts';
import { readGuideBytes } from '../corpus/guide.ts';
import { unitRegenerateLanes } from '../input/derived.ts';
import { withinEnvelope } from '../input/envelope.ts';
import { corpusFileSet, scopeOverlapsCorpus, scopeReferences } from '../phase0/rows.ts';
import { diffBase, unitDiffPaths } from '../git/transient.ts';
import {
  type CorpusInForce, type InputFiles, type LoadedSpec, CORPUS_FILE_INPUT, OBLIGATIONS_INPUT, PLAN_INPUT, RULING_INPUT, RULINGS_INPUT, SPEC_INPUT, VISION_INPUT, inForceFiles,
  inputPath, keptInput, keptPayload, parseUnitSpec, requirePlanInForce, revisionInForce, specBytesOf, specShaInForce,
} from '../input/inforce.ts';
import { type KnownDefect, type PlanUnit, advancesOf, knownDefectsOf, parsePlan, planCheckShapeOf, targetDocumentPaths, targetDocuments } from '../input/plan.ts';
import { type CorpusView, materialiseCorpus } from '../corpus/materialise.ts';
import { openFinding, visionConflictDraft } from '../holistic/findings.ts';
import { type Obligations, type RulingSidecar, type Vision, parseObligations, parseRulingSidecar, parseVision } from '../holistic/types.ts';
import { promptFor } from '../prompts/index.ts';
import type {
  ArchitectureInput, BuildAssess, Checkout, CorpusInput, DeliveredWitness, DocText, EscalationInput, FastLane, GateTargetInput, PlanCheckAcceptance, PlanCheckCheckouts, PlanCheckPriorRound,
  PlanCheckScopeGrowth, ReferenceIndex,
  RulingText,
  TargetInput, VisionInput,
} from '../prompts/inputs.ts';
import { visionInputOf } from '../prompts/inputs.ts';
import {
  DECISIONS_FILE, type DecisionsFile, PLAN_ASSESSMENT_SCHEMA, type PlanAssessmentOutput, type PlanCheckOutput, type Premise, buildOutputFor,
  buildSchemaFor, isAcceptanceSchema, planCheckAcceptanceSchemaFor, validateDecisionsFile, validatePlanAssessment, validatePlanCheckAcceptanceOutput, validatePlanCheckOutput,
} from '../prompts/schemas.ts';
import { ASSESSED_DIRECTIVE, judgmentRepairDirective } from '../prompts/directives.ts';
import { type ParkFacts, NO_PARK_FACTS, repeatNeedsUser, stageOutcomeFact } from '../park/table.ts';
import { resolveArgv0 } from '../preflight/argv0.ts';
import type { JudgmentRole, JudgmentSeat } from '../routing/types.ts';
import { buildCpu, requestOf } from '../resources/pool.ts';
import { probe } from '../resources/probe.ts';
import { type Reservation, type StageHolder, cleanup, fastLanes, heldReservation, holderUnits, run } from '../resources/reserve.ts';
import { knownDefectActive } from '../schedule/ready.ts';
import { CPU_COST, type ResourceRequest } from '../schedule/types.ts';
import { renderSpec } from '../spec/render.ts';
import { bytesSha256, evidenceScopeConflicts, specBytes } from '../spec/spec.ts';
import { evaluateRevision } from '../commands/apply.ts';
import { witnessLaneReasons } from '../input/classify.ts';
import { type Ruling, parseRulings } from '../spec/rulings.ts';
import { SpecPatchOpError, SpecPatchStaleError, applySpecPatch, specPatchOp } from '../spec/patch.ts';
import { runnerFiles } from '../runner/files.ts';
import {
  type BackendCallOutcome, type BackendCallSpec, type BackendVerdict, type Cancelled, type ImplementerDispatch, type Pinned, type StageContext, type StageParent,
  backendOf, callBackend, cancelledNow, dispatchOf, enter, evidenceRoot, implementerDispatch, isCancelled, judgmentDeadlineMs, judgmentDispatch, nonEmpty, pinDispatch,
  fastSuiteWorktree, raiseRisk, riskAbove, runOp, runPrepared, sameSession, steerDispatch, unitBranch, unitWorktree, verdictOf, verificationWorktree, workDir,
} from './dispatch.ts';
import { invocationDir, quiescent } from './invoke.ts';
import {
  type LaneRecord, type LaneRuntime, type Series, type VerificationTree, dirtyPaths, fastSuiteLanes, laneOrder, laneRuntime, presentCheckouts, removeCheckout,
  removeVerificationTree, runLaneSeries, seriesEntry, specSeriesRoot,
} from './lanes.ts';
import { mutationSmoke, survivingObligations } from './smoke.ts';
import { pressureCause, seriesRuling } from './starved.ts';
import { checksApply, publishWitnessLaneFiles, requiredAt, witnessPresence } from './witnesscheck.ts';
import {
  type DecidedRound, type RoundCall, type RoundInput, callRound, decidedRound, escalateImplementer, freshSession, invocationSession, laneFixRound, prepareRound,
  resumed,
} from './rounds.ts';
import { type BuildRound, type Next, type StageOutcome, outcomeFact, transition } from './transitions.ts';
import { evidenceSnapshotOp, salvageCommitOp, worktreeCreateOp, worktreeRemoveOp } from '../recover/ops.ts';

/** One stage attempt, recorded. `needsUser`: content beyond the table's own, for the caller to write. */
export type StageDone<S extends OutcomeStage> = Readonly<{
  attempt: number;
  outcome: Extract<StageOutcome, Readonly<{ stage: S }>>;
  next: Next;
  needsUser: NeedsUserContent | null;
}>;

/** A new attempt of `stage`: attempts are numbered across the unit's stages, from the fold's count. */
export function start(ctx: StageContext, unit: UnitId, stage: OutcomeStage): StageParent {
  return { type: 'stage', unit, stage, attempt: ctx.journal.view.unit(unit).counters.attempts + 1 };
}

/**
 * Records the attempt's stage-outcome fact and returns the decision the table makes from the fold's state. The
 * fact goes through the park table (`stageOutcomeFact`): a retryable park names its targets from `facts` (the
 * call's backend, the instances a cleanup failed), and a hold its backend-park `cause` (G5). A retryable park
 * that repeats within PARK_REPEAT_MS of a recovery on one of its targets is written operator, and its item's
 * reason becomes `env-blocked` (`repeatNeedsUser`), both in `next` and in the stage's own content. `detail` (M4a rev 3):
 * what a `DETAILED_OUTCOMES` outcome carries.
 */
export function record<S extends OutcomeStage>(
  ctx: StageContext, parent: StageParent & Readonly<{ stage: S }>, kind: StageOutcomeKind<S>, needsUser: NeedsUserContent | null = null,
  facts: ParkFacts = NO_PARK_FACTS, cause?: HoldCause, detail?: StageOutcomeDetail,
): StageDone<S> {
  const outcome = { stage: parent.stage, kind } as Extract<StageOutcome, Readonly<{ stage: S }>>;
  const u = ctx.journal.view.unit(parent.unit);
  const next = transition(u, outcome);
  const parked = stageOutcomeFact(u, outcome, parent.attempt, facts, new Date(), cause);
  // M4a rev 3: the outcomes `DETAILED_OUTCOMES` names carry their detail (the fact's reader requires it exactly there).
  ctx.journal.fact(detail === undefined ? parked.fact : { ...parked.fact, detail });
  if (!parked.repeat) return { attempt: parent.attempt, outcome, next, needsUser };
  if (next.kind !== 'park') throw new Error(`${parent.unit} ${parent.stage}#${parent.attempt}: a repeat park the table decides as ${next.kind}`);
  const repeat = repeatNeedsUser(u, parked.fact, next.needsUser);
  return { attempt: parent.attempt, outcome, next: { ...next, needsUser: repeat }, needsUser: needsUser === null ? null : { ...needsUser, ...repeat } };
}

/** The park facts of a cleanup: the instances it failed. */
export const failedFacts = (failed: readonly ResourceInstance[]): ParkFacts => ({ backend: null, failed });

// ---------------------------------------------------------------------------------------------------
// Entry reservations (A1, F6)

/** The holder a stage attempt reserves under. */
export const stageHolder = (parent: StageParent): StageHolder => ({ type: 'stage', unit: parent.unit, stage: parent.stage, attempt: parent.attempt });

/** A judgment's entry reservation: `@cpu`×1. */
export const judgmentEntry = (): ResourceRequest => ({ named: [], pools: [], cpu: CPU_COST.judgment, publication: false });

/** A build's entry reservation: the unit's declared resources and its `@cpu` (`buildCpu`). */
export const buildEntry = (ctx: StageContext, unit: PlanUnit): ResourceRequest | null =>
  nonEmpty(requestOf(ctx.plan(), unit.resources, buildCpu(unit)));

/** What an attempt holds once its entry grant is probed and running, or why it may not run. */
export type Held =
  | Readonly<{ kind: 'held'; reservation: Reservation<'running', StageHolder> | null }>
  | Readonly<{ kind: 'occupied'; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'cleanup-failed'; failed: readonly ResourceInstance[] }>;

/**
 * After its entry grant: the occupancy probe of every instance the attempt reserved (none for `@cpu`), then
 * `run`. A parked probe cleans the reservation up. `held` with null when the attempt reserved nothing.
 */
export async function holdEntry(ctx: StageContext, parent: StageParent): Promise<Held> {
  const holder = stageHolder(parent);
  if (holderUnits(ctx.journal.view, holder).length === 0) return { kind: 'held', reservation: null };
  const reserved = heldReservation(ctx, holder, 'reserved');
  const occupancy = await probe(ctx, reserved, parent);
  if (occupancy.kind === 'parked') {
    const cleaned = await cleanup(ctx, reserved, parent);
    return cleaned.kind === 'cleanup-failed' ? { kind: 'cleanup-failed', failed: cleaned.failed } : { kind: 'occupied', needsUser: occupancy.needsUser };
  }
  return { kind: 'held', reservation: run(ctx, reserved, parent) };
}

/**
 * A judgment attempt's entry: `@cpu`×1 granted and running, or the wait cancelled (nothing journaled). Taken only
 * after the attempt's capture under the fence (never while waiting for it).
 */
export async function enterJudgment(ctx: StageContext, parent: StageParent): Promise<Readonly<{ kind: 'entered' }> | Cancelled> {
  const entered = await enter(ctx, stageHolder(parent), judgmentEntry());
  if (isCancelled(entered)) return entered;
  if ((await holdEntry(ctx, parent)).kind !== 'held') throw new Error(`${parent.unit} ${parent.stage}#${parent.attempt}: a judgment's @cpu has no probe, so it cannot be occupied`);
  return entered;
}

/**
 * Releases what a judgment attempt still holds (its `@cpu` token, which has no teardown, so its cleanup cannot
 * fail): once its call is read, or before it records an outcome without one. Nothing when it holds nothing (a call
 * recovered after a crash, whose dead holder recovery released).
 */
export async function releaseJudgment(ctx: StageContext, parent: StageParent): Promise<void> {
  const holder = stageHolder(parent);
  if (holderUnits(ctx.journal.view, holder).length === 0) return;
  const cleaned = await cleanup(ctx, heldReservation(ctx, holder, 'running'), parent);
  if (cleaned.kind !== 'released') throw new Error(`${parent.unit} ${parent.stage}#${parent.attempt}: its judgment reservation was not released: ${cleaned.kind}`);
}

/**
 * The durable inputs of a judgment attempt (F1), written under the fence before its entry reservation and its
 * backend spawn: what a call recovered after a crash is read against (gate.ts `consumeJudgment`). A gate's carry
 * its complete approval fingerprint.
 */
export function writeJudgmentInputs(
  ctx: StageContext, parent: StageParent & Readonly<{ stage: 'plan-check' | 'gate' }>,
  inputs: Readonly<{ tip: Sha; head: Sha | null; specRev: SpecRev; specSha256: Sha256Hex; routingRev: RoutingRev; fingerprint?: ApprovalFingerprint; diffShown?: DiffShown; largeDiff?: GateLargeDiff | null }>,
): void {
  const applied = ctx.journal.view.planApplied();
  if (applied === null) throw new Error(`${parent.unit} ${parent.stage}#${parent.attempt}: a judgment before any plan revision`);
  ctx.journal.fact({ kind: 'judgment-inputs', unit: parent.unit, stage: parent.stage, attempt: parent.attempt, ...inputs, planRev: applied.rev });
}


export const at = <S extends OutcomeStage>(p: StageParent, stage: S): StageParent & Readonly<{ stage: S }> => {
  if (p.stage !== stage) throw new Error(`a ${p.stage} attempt used as ${stage}`);
  return p as StageParent & Readonly<{ stage: S }>;
};

// ---------------------------------------------------------------------------------------------------
// Inputs, snapshotted by revision

/**
 * The unit's spec in force (src/input/inforce.ts): the bytes its record names once dispatched, else the plan
 * in force's, read from the run dir and never from the live file. `path` is the spec file the architect
 * edits (relative to the plan dir), for what a needs-user tells them.
 */
export function loadUnitSpec(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath; planDir: AbsPath }>, unit: PlanUnit): LoadedSpec {
  const path = absPath(join(ctx.planDir, unit.spec));
  const sha256 = specShaInForce(ctx.journal.view, unit.id);
  return { path, spec: parseUnitSpec(specBytesOf(ctx.runDir, sha256), path, unit.id), sha256 };
}

/** The kept file of the unit's spec in force: what a snapshot publishes and a park's evidence cites. */
export function keptSpecPath(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath; planDir: AbsPath }>, unit: PlanUnit): AbsPath {
  return inputPath(ctx.runDir, loadUnitSpec(ctx, unit).sha256, SPEC_INPUT);
}

export function integrationTip(ctx: StageContext): Sha {
  return revParse(ctx.repo, branchRef(ctx.plan().integrationBranch));
}

/** A product document as committed at `tip`. */
export function docAt(ctx: StageContext, tip: Sha, path: RepoPath): DocText {
  return { path, text: git(ctx.repo, ['cat-file', 'blob', `${tip}:${path}`]) };
}

/** The rulings ledger's path (plan `rulings`, relative to the plan dir); judgments read it through `--add-dir`. */
export const ledgerPath = (ctx: StageContext): AbsPath => absPath(join(ctx.planDir, ctx.plan().rulings));
/** The directory a session is given to read the ledger from. */
export const ledgerDir = (ctx: StageContext): AbsPath => absPath(dirname(ledgerPath(ctx)));

/** The rulings ledger in force (A3: executor-owned after start): the bytes the latest revision's payload kept. */
export function ledger(ctx: StageContext): readonly Ruling[] {
  const payload = payloadInForce(ctx);
  return parseRulings(kept(ctx, payload.manifest.rulings.ledgerSha256, RULINGS_INPUT).toString('utf8'), ledgerPath(ctx));
}

/** The ruling sidecars in force (M3). */
export function rulingSidecars(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>): readonly RulingSidecar[] {
  const payload = payloadInForce(ctx);
  return Object.values(payload.manifest.rulings.sidecars).map((sha) => parseRulingSidecar(JSON.parse(kept(ctx, sha, RULING_INPUT).toString('utf8'))));
}

/** The latest revision's payload. */
function payloadInForce(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>): ReturnType<typeof keptPayload> {
  const fact = ctx.journal.view.planApplied();
  if (fact === null) throw new Error('a stage before any plan revision');
  return keptPayload(ctx.runDir, fact.payloadSha256);
}

function kept(ctx: Readonly<{ runDir: AbsPath }>, sha: Sha256Hex, ext: string): Buffer {
  const bytes = keptInput(ctx.runDir, sha, ext);
  if (bytes === null) throw new Error(`the revision in force names ${ext} ${sha}, which is not kept`);
  return bytes;
}

/**
 * The vision and obligations in force (M3): the latest revision's kept bytes; null where it names none (a
 * non-holistic arc, a holistic one without obligations).
 */
export function holisticInForce(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>): Readonly<{ vision: Vision | null; obligations: Obligations | null }> {
  const payload = payloadInForce(ctx);
  const read = <T>(sha: Sha256Hex | null, ext: string, parse: (v: unknown) => T): T | null =>
    (sha === null ? null : parse(JSON.parse(kept(ctx, sha, ext).toString('utf8'))));
  return {
    vision: read(payload.manifest.vision, VISION_INPUT, parseVision),
    obligations: read(payload.manifest.obligations, OBLIGATIONS_INPUT, parseObligations),
  };
}

/**
 * The vision in force as a prompt reads it (every clause, withdrawn ones marked, its open questions, and the slice the
 * plan of the same revision advances), or null outside a holistic arc.
 */
export function visionInput(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>): VisionInput | null {
  const { vision } = holisticInForce(ctx);
  if (vision === null) return null;
  const payload = payloadInForce(ctx);
  if (payload === null) throw new Error('a vision in force without a revision payload');
  return visionInputOf(vision, advancesOf(parsePlan(JSON.parse(kept(ctx, payload.manifest.planSha256, PLAN_INPUT).toString('utf8')))));
}

/** A document's first Markdown heading, for the reference index. */
function firstHeading(text: string): string {
  return /^#{1,6}[ \t]+(.*\S)[ \t]*$/m.exec(text)?.[1] ?? '(no heading)';
}

/** A rule's first sentence, for the reference index. */
function firstSentence(text: string): string {
  return /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
}

/** What a unit's prompts embed in full (its cited contracts and active rulings) and the index of the rest. */
export type Library = Readonly<{ contracts: readonly DocText[]; rulings: readonly RulingText[]; index: ReferenceIndex }>;

/**
 * The unit's library at `tip`: the contracts and active rulings its spec cites, in full, and every other
 * plan contract and ledger ruling as one index line (a withdrawn ruling, cited or not, is its fold line).
 * Startup refuses a cite the plan or ledger does not hold (the plan-invalid `unknown-cite` row).
 */
export function library(ctx: StageContext, spec: SpecM1, tip: Sha): Library {
  const rulings = ledger(ctx);
  const cited = (r: Ruling): boolean => r.status === 'active' && spec.cites.rulings.includes(r.id);
  return {
    contracts: spec.cites.contracts.map((c) => docAt(ctx, tip, c)),
    rulings: rulings.flatMap((r) => (r.status === 'active' && cited(r) ? [{ id: r.id, text: r.text }] : [])),
    index: {
      contracts: ctx.plan().contracts.filter((c) => !spec.cites.contracts.includes(c)).map((path) => ({ path, heading: firstHeading(docAt(ctx, tip, path).text) })),
      rulings: rulings.filter((r) => !cited(r)).map((r) => ({ id: r.id, line: r.status === 'active' ? firstSentence(r.text) : `withdrawn by ${r.by}` })),
      ledger: ledgerPath(ctx),
    },
  };
}

/**
 * The target a judgment embeds at `tip` (plan-check, the lenses, the checkpoint): an `architecture-doc` arc's digest when
 * the plan names one, else the whole doc; a corpus arc's pinned corpus in force (`corpusTarget`), the vision document
 * included. The gate's is `gateTarget`.
 */
export function architecture(ctx: StageContext, tip: Sha): TargetInput {
  return documentTarget(ctx, tip) ?? corpusTarget(ctx, 'full');
}

/** The gate's target: as `architecture`, but a corpus arc's view omits the vision document (M3 R17). */
export function gateTarget(ctx: StageContext, tip: Sha): GateTargetInput {
  return documentTarget(ctx, tip) ?? { ...corpusTarget(ctx, 'without-vision'), visionDoc: null };
}

/** The directories a judgment reads beside its checkout for `target`: a corpus arc's materialised pin (`--add-dir`). */
export const targetDirs = (target: TargetInput): readonly AbsPath[] => (target.kind === 'corpus' ? [target.dir] : []);

function documentTarget(ctx: StageContext, tip: Sha): ArchitectureInput | null {
  const t = targetDocuments(ctx.plan());
  if (t === null) return null;
  return t.digest === null
    ? { kind: 'full', doc: docAt(ctx, tip, t.doc) }
    : { kind: 'digest', digest: docAt(ctx, tip, t.digest), doc: t.doc };
}

/** A corpus arc's corpus inputs in force (the pin, guide, Phase-0 record and capture), from the revision in force. */
export function corpusInForce(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>): CorpusInForce {
  const corpus = revisionInForce(ctx.runDir, requirePlanInForce(ctx.runDir, ctx.journal.view)).corpus;
  if (corpus === null) throw new Error(`arc ${ctx.journal.view.arc}: the revision in force keeps no corpus inputs`);
  return corpus;
}

/**
 * A corpus arc's target (M4a "Corpus, pin and census" 5): every active pinned rule embedded (the rules index; the vision
 * document holds none), and the pinned files materialised read-only from their kept bytes under
 * `<runDir>/corpus/<pinSha8>/` (`view` without-vision: `<pinSha8>.no-vision/`, M3 R17). Idempotent: the view is
 * content-addressed, so a capture under the fence makes it once per pin.
 */
function corpusTarget(ctx: StageContext, view: CorpusView): CorpusInput {
  const { pin } = corpusInForce(ctx);
  const dir = materialiseCorpus(ctx.runDir, pin.value, pin.sha256, view, (f) => {
    const bytes = keptInput(ctx.runDir, f.sha256, CORPUS_FILE_INPUT);
    if (bytes === null) throw new Error(`the pin in force (${pin.sha256}) names ${f.path} (${f.sha256}), which is not kept`);
    return bytes;
  });
  return { kind: 'corpus', rulesIndex: pin.value.rules, dir, visionDoc: view === 'full' ? pin.value.vision.path : null };
}

/** The product documents whose change touches the unit's authority: every plan contract, the architecture doc and its digest. */
export function authorityPaths(ctx: StageContext): ReadonlySet<RepoPath> {
  return new Set<RepoPath>([...ctx.plan().contracts, ...targetDocumentPaths(ctx.plan())]);
}

export const inMs = (ms: number) => isoTimeOf(new Date(Date.now() + ms));

type JudgmentOrBuild = 'plan-check' | 'build' | 'gate';

/**
 * Records a call that did not succeed: interrupted (a hold, with its backend-park cause, G5), refusal, malformed,
 * or a process fault (a retryable park on the call's backend).
 */
export function verdictKind<S extends JudgmentOrBuild>(
  ctx: StageContext, parent: StageParent & Readonly<{ stage: S }>, v: Exclude<BackendVerdict, Readonly<{ kind: 'success' }>>, called: BackendCallOutcome,
): StageDone<S> {
  if (v.kind === 'interrupted') return record(ctx, parent, 'interrupted' as StageOutcomeKind<S>, v.needsUser, NO_PARK_FACTS, v.cause ?? undefined);
  if (v.kind === 'process-fault') return record(ctx, parent, 'process-fault' as StageOutcomeKind<S>, null, { backend: backendOf(called), failed: [] });
  if (v.kind === 'context-exceeded') {
    const detail = { kind: 'context-exceeded', inv: v.inv, promptBytes: v.promptBytes } as const;
    return record(ctx, parent, 'context-exceeded' as StageOutcomeKind<S>, null, NO_PARK_FACTS, undefined, detail);
  }
  return record(ctx, parent, v.kind as StageOutcomeKind<S>);
}

// ---------------------------------------------------------------------------------------------------
// plan-check

/** `session` is null when no judgment was asked (a routing change parked the unit first). */
export type PlanCheckDone = StageDone<'plan-check'> & Readonly<{ session: JudgmentSessionId | null; specRev: SpecRev }>;

/** The resources a patch's lanes would take beyond the unit's declared set: widening its envelope. */
function widenedResources(unit: PlanUnit, patch: PlanCheckOutput['patch']): readonly string[] {
  return (patch ?? []).flatMap((op) => (op.op === 'add' || op.op === 'replace') && op.section === 'lanes'
    ? op.item.resources.filter((r) => !unit.resources.includes(r))
    : []);
}

/** A plan-check attempt's checkout of the integration tip (`tip`) or of the unit branch (`branch`). */
export const planCheckWorktree = (ctx: StageContext, parent: StageParent, tree: 'tip' | 'branch'): AbsPath =>
  absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${parent.unit}.plan-check-${parent.attempt}${tree === 'branch' ? '-branch' : ''}`));

/** The checkouts a plan-check attempt created, read back from its `worktree.create` intents. */
function planCheckCheckoutsOf(ctx: StageContext, parent: StageParent): PlanCheckCheckouts {
  const created = attemptOps(ctx, parent, 'worktree.create');
  const tree = (which: 'tip' | 'branch'): Checkout | null => {
    const c = created.find((i) => i.expect.path === planCheckWorktree(ctx, parent, which));
    if (c === undefined) return null;
    if (c.expect.checkout.type !== 'detached') throw new Error(`plan-check checkout ${c.expect.path} is not detached`);
    return { path: c.expect.path, at: c.expect.checkout.at };
  };
  const tip = tree('tip');
  if (tip === null) throw new Error(`plan-check ${parent.unit}#${parent.attempt} made no checkout of the integration tip`);
  return { tip, branch: tree('branch') };
}

/**
 * Removes every plan-check checkout of the unit still present (this attempt's once its call is read, or a
 * leftover of an attempt a crash cut short), each citing a snapshot of whatever it holds beyond its commit
 * (a judge is read-only, so normally a manifest of zero files; lead ruling 14c). Verification checkouts
 * are the lanes stage's and retire's to remove, never this one's.
 */
async function removePlanCheckCheckouts(ctx: StageContext, unit: UnitId, parent: StageParent): Promise<void> {
  const present = presentCheckouts(ctx.journal.view, unit).filter((c) => c.parent.type === 'stage' && c.parent.stage === 'plan-check');
  for (const created of present) {
    if (created.parent.type !== 'stage') throw new Error(`${created.expect.path}: a plan-check checkout without a stage parent`);
    const { path } = created.expect;
    const dest = absPath(join(evidenceRoot(ctx.runDir, created.parent), basename(path)));
    const view = ctx.journal.view;
    const snapped = view.opsOf('evidence.snapshot').find((i) => i.expect.dest === dest && view.doneOf(i.op) !== null)
      ?? await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${unit}`, parent, { source: path, globs: dirtyPaths(path).map(pathPattern), dest });
    await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${unit}:plan-check`, parent, { path, evidence: capturedEvidence(ctx.journal.view, snapped.op) });
  }
}

/** The attempt's checkouts, not yet made: the integration tip `tip`, and the unit branch when it exists and differs. */
function planCheckCheckoutsAt(ctx: StageContext, unit: UnitId, parent: StageParent, tip: Sha): PlanCheckCheckouts {
  const branchTip = refTarget(ctx.repo, unitBranch(ctx.plan().arc, unit));
  return {
    tip: { path: planCheckWorktree(ctx, parent, 'tip'), at: tip },
    branch: branchTip === null || branchTip === tip ? null : { path: planCheckWorktree(ctx, parent, 'branch'), at: branchTip },
  };
}

/** Makes the attempt's checkouts at the commits its capture read. */
async function createPlanCheckCheckouts(ctx: StageContext, unit: UnitId, parent: StageParent, checkouts: PlanCheckCheckouts): Promise<void> {
  for (const c of [checkouts.tip, ...(checkouts.branch === null ? [] : [checkouts.branch])]) {
    await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${unit}:plan-check`, parent, { path: c.path, checkout: { type: 'detached', at: c.at } });
  }
}

/** A path a premise cites, as a repository path, or null when it names nothing in a tree (absolute, or outside). */
function premiseRepoPath(path: string): string | null {
  if (isAbsolute(path)) return null;
  const p = normalize(path);
  return p === '..' || p.startsWith('../') ? null : p;
}

/** The blob id of `path` at `commit`, or null when the commit has no such file. */
function blobAt(ctx: StageContext, commit: Sha, path: string): string | null {
  const r = gitRun(ctx.repo, ['rev-parse', '--verify', '-q', `${commit}:${path}`], { okCodes: [0, 1, 128] });
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * The files a round's premises cite whose content differs between the trees that round read and the ones
 * the next round reads (`pairs`: [then, now] commits, either null when that tree did not exist). A path
 * that names no repository file (an evidence dir, say) cannot be compared and counts as changed.
 */
export function changedPremiseFiles(ctx: StageContext, premises: readonly Premise[], pairs: readonly (readonly [Sha | null, Sha | null])[]): readonly string[] {
  const paths = [...new Set(premises.flatMap((p) => p.evidence.map((e) => e.path)))];
  return paths.filter((path) => {
    const p = premiseRepoPath(path);
    if (p === null) return true;
    return pairs.some(([then, now]) => (then === null ? null : blobAt(ctx, then, p)) !== (now === null ? null : blobAt(ctx, now, p)));
  }).sort();
}

/** What reading a judgment's recorded answers needs: the journal and the run dir (a stage's context, or status's). */
export type JudgmentReader = Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>;

/** A unit's backend spawns of one judgment role, in log order. */
export const judgmentSpawns = (ctx: JudgmentReader, unit: UnitId, role: JudgmentRole): readonly IntentOf<'proc.spawn'>[] =>
  ctx.journal.view.opsOf('proc.spawn').filter((i) => {
    const s = i.expect.subject;
    return s.purpose === 'backend' && s.role === role && s.unit === unit;
  });

/** The validated output of a judgment spawn, or null when it has none (a fault, a refusal, a malformed answer). */
export function judgmentOutput<T>(ctx: JudgmentReader, intent: IntentOf<'proc.spawn'>, validate: (value: unknown) => T): T | null {
  if (ctx.journal.view.doneOf(intent.op)?.outcome.kind !== 'result') return null;
  const inv = invocationId(intent.op, intent.ordinal);
  const result = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('result.json');
  if (result === null || result.type !== 'backend') throw new Error(`${inv}: a done judgment spawn without its backend result`);
  if (result.outcome.kind !== 'success') return null;
  try {
    return validate(result.outcome.value);
  } catch (error) {
    if (error instanceof SchemaError) return null;
    throw error;
  }
}

/**
 * W3 (2026-10-16): why a judgment of `stage` runs at the escalation seat, for its prompt (null below that seat). A route-up
 * carries the seat below's latest answer (null when that spawn gave none: a refusal); otherwise a risk trigger promoted it.
 */
export function escalationOf(
  ctx: StageContext, unit: UnitId, stage: JudgmentStage, tier: JudgmentSeat, validate: (value: unknown) => Readonly<{ decision: string; reasons: readonly string[] }>,
): EscalationInput | null {
  if (tier !== 'escalation') return null;
  if (!ctx.journal.view.unit(unit).routedUp.includes(stage)) return { kind: 'risk-trigger' };
  const below = judgmentSpawns(ctx, unit, stage === 'gate' ? 'gate' : 'planCheck').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.tier !== 'escalation').at(-1);
  if (below === undefined) throw new Error(`${unit}: the ${stage} routed up with no spawn below the escalation seat`);
  const out = judgmentOutput(ctx, below, validate);
  return { kind: 'route-up', first: out === null ? null : { decision: out.decision, reasons: out.reasons } };
}

/**
 * The round handoff of a plan-check after its own redirect: the unit's latest plan-check answer, when it
 * redirected and its patch was applied (a redirect beyond the bound escalates unpatched, and the next
 * check starts fresh). Changed premise files compare the prior attempt's checkouts with `now`'s.
 */
function planCheckPriorRound(ctx: StageContext, unit: UnitId, now: PlanCheckCheckouts): PlanCheckPriorRound | null {
  const spawns = judgmentSpawns(ctx, unit, 'planCheck');
  for (let i = spawns.length - 1; i >= 0; i--) {
    const spawn = spawns[i]!;
    const out = judgmentOutput(ctx, spawn, validatePlanCheckOutput);
    if (out === null) continue;
    if (out.decision !== 'redirect' || spawn.parent.type !== 'stage') return null;
    const applied = attemptOps(ctx, spawn.parent, 'spec.patch').find((p) => ctx.journal.view.doneOf(p.op) !== null && p.expect.patch.by.role === 'planCheck');
    if (applied === undefined) return null;
    const then = planCheckCheckoutsOf(ctx, spawn.parent);
    return {
      patch: out.patch, reasons: out.reasons, premises: out.premises, patchedRev: applied.post.newRev,
      changedPremiseFiles: changedPremiseFiles(ctx, out.premises, [[then.tip.at, now.tip.at], [then.branch?.at ?? null, now.branch?.at ?? null]]),
    };
  }
  return null;
}

/** The approving plan-check's notes: facts it reported for the build and the gate (arc-1 feedback item 26). */
export function planCheckNotes(ctx: StageContext, unit: UnitId): string {
  const spawns = judgmentSpawns(ctx, unit, 'planCheck');
  for (let i = spawns.length - 1; i >= 0; i--) {
    const out = judgmentOutput(ctx, spawns[i]!, validatePlanCheckOutput);
    if (out !== null) return out.decision === 'approve' ? out.notes : '';
  }
  return '';
}

// ---------------------------------------------------------------------------------------------------
// Plan-check shape by builder class (M4a rev 3, E, R40, R55, R59)

/**
 * How a unit's plan-check runs: `uniform` (the plan's default, every non-corpus arc, and a corpus arc without arc lanes,
 * R40); under `planCheck.shape: by-builder` the class `build.<risk floor>` resolves to under the unit's routing decides:
 * `frontier` or `summit` assesses in session (no plan-check call), `efficient` gets the acceptance shape.
 */
export type PlanCheckShape = 'uniform' | 'in-session' | 'acceptance';
export function planCheckShape(ctx: StageContext, unit: UnitId): PlanCheckShape {
  if (planCheckShapeOf(ctx.plan()) !== 'by-builder' || !checksApply(ctx)) return 'uniform';
  if ((holisticInForce(ctx).obligations?.lanes.length ?? 0) === 0) return 'uniform';
  const builder = ctx.routing(unit).classes.build[dispatchOf(ctx.journal.view, unit).riskFloor];
  return builder === 'efficient' ? 'acceptance' : 'in-session';
}

/**
 * 2026-10-15 (arc feedback #3): the park of a unit whose spec holds an active witness item on a lane that is no arc lane in
 * force, at build (its lane file cannot be published) or lanes (its witness cannot run), in a corpus arc where the checks
 * apply; null when every witness item names an arc lane. The classifier refuses such a spec at every revision since; an
 * arc started on 1.0.0-dev.9 may still hold one, and parks here instead of crash-looping (`requiredLanes` would throw).
 */
function witnessLanePark(ctx: StageContext, unit: PlanUnit, spec: SpecM1): NeedsUserContent | null {
  if (!checksApply(ctx)) return null;
  const why = witnessLaneReasons(unit.id, spec, holisticInForce(ctx).obligations);
  if (why.length === 0) return null;
  return {
    blocking: true,
    subject: { type: 'unit', unit: unit.id },
    reason: 'witness-lane-missing',
    summary: `Unit ${unit.id}: ${why.join('; ')}. Its required witnesses cannot be checked, so the unit is parked.`,
    recommendation: `Add the lane to the arc's obligations with \`roadmap apply\` and then \`roadmap resume ${unit.id}\`; or re-enter the unit with a spec whose witness items name arc lanes.`,
    options: [],
    evidence: [keptSpecPath(ctx, unit)],
  };
}

/** The arc lanes in force, ascending: the lanes a witness item may name. */
const arcLanesOf = (ctx: StageContext): readonly LaneId[] => [...(holisticInForce(ctx).obligations?.lanes.map((l) => l.id) ?? [])].sort();

/**
 * Paid M4b run 6: the witnesses of the obligations `unit` delivers or repairs at `tip` (`requiredAt`'s target obligation
 * rows), one entry per obligation, ascending by id. Each test id is already required of the unit by its exact id.
 */
function deliveredWitnesses(ctx: StageContext, unit: PlanUnit, tip: Sha): readonly DeliveredWitness[] {
  const byId = new Map((holisticInForce(ctx).obligations?.obligations ?? []).map((o) => [o.id, o]));
  const out = new Map<ObligationId, DeliveredWitness>();
  for (const r of requiredAt(ctx, unit, tip)) {
    if (r.role !== 'target' || r.source.type !== 'obligation') continue;
    const o = byId.get(r.source.id);
    if (o === undefined) throw new Error(`unit ${unit.id}: a required witness names ${r.source.id}, which the obligations in force do not hold`);
    out.set(o.id, { obligation: o.id, statement: o.statement, lane: r.lane, testIds: [...(out.get(o.id)?.testIds ?? []), r.testId] });
  }
  return [...out.values()].sort((a, b) => compareIds(a.obligation, b.obligation));
}

/**
 * The acceptance shape's inputs (R59): the spec's next free witness item id, the arc lanes an item may name, and the
 * witnesses of the obligations the unit delivers at `tip`.
 */
function acceptanceOf(ctx: StageContext, unit: PlanUnit, spec: SpecM1, tip: Sha): PlanCheckAcceptance {
  const seqs = specWitnesses(spec).map((w) => witnessItemSeq(w.id));
  return { nextWitnessId: witnessItemIdOf(Math.max(0, ...seqs) + 1), arcLanes: arcLanesOf(ctx), delivered: deliveredWitnesses(ctx, unit, tip) };
}

/** A plan-check invocation's backend terminal, from its launch.json. */
function planCheckTerminal(ctx: StageContext, inv: InvocationId) {
  const launch = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('launch.json');
  if (launch === null || launch.terminal.type !== 'backend') throw new Error(`${inv}: a plan-check invocation without its backend launch.json`);
  return launch.terminal;
}

/** Whether plan-check invocation `inv` asked the acceptance shape: the schema its launch names is that shape's (`isAcceptanceSchema`). */
function isAcceptanceCall(ctx: StageContext, inv: InvocationId): boolean {
  return isAcceptanceSchema(JSON.parse(readFileSync(planCheckTerminal(ctx, inv).schemaPath, 'utf8')));
}

export async function planCheck(ctx: StageContext, unit: PlanUnit): Promise<PlanCheckDone | Cancelled> {
  const { spec, sha256 } = loadUnitSpec(ctx, unit);
  const parent = at(start(ctx, unit.id, 'plan-check'), 'plan-check');
  // A cancelled task captures nothing (its `@cpu` wait, after the capture, would be cancelled at once).
  const cancelled = cancelledNow(ctx);
  if (cancelled !== null) return cancelled;
  const pin = pinDispatch(ctx, unit, { rev: spec.rev, sha256 });
  // E (R55): a frontier or summit builder under `by-builder` makes no plan-check call; its fresh build assesses first.
  const shape = pin.kind === 'pinned' ? planCheckShape(ctx, unit.id) : 'uniform';
  if (shape === 'in-session') {
    crashPoint('plancheck.after-pin-in-session', unit.id);
    return { ...record(ctx, parent, 'in-session'), session: null, specRev: spec.rev };
  }
  const judged = pin.kind === 'pinned' ? judgmentDispatch(ctx, unit.id, 'plan-check') : pin;
  if (pin.kind !== 'pinned' || judged.kind !== 'pinned') {
    return { ...record(ctx, parent, 'routing-changed', judged.kind === 'pinned' ? null : judged.needsUser), session: null, specRev: spec.rev };
  }
  const pinned = pin.dispatch;
  const seat = judged.dispatch;
  const prompt = promptFor('planCheck', seat.triple.model);
  const session = freshJudgmentSession();
  // H2: the tip, the inputs in force and the prompt rendered from them, captured with `judgment-inputs` under the
  // fence before the `@cpu` entry (never held while waiting for the fence); the checkouts are then made at the
  // captured commits.
  const captured = await captureUnderFence(ctx.journal, () => {
    const now = loadUnitSpec(ctx, unit);
    const checkouts = planCheckCheckoutsAt(ctx, unit.id, parent, integrationTip(ctx));
    const target = architecture(ctx, checkouts.tip.at);
    const rendered = prompt.render({
      spec: { unit: unit.id, rev: now.spec.rev, markdown: renderSpec(now.spec) }, ...library(ctx, now.spec, checkouts.tip.at), target,
      direction: ctx.plan().direction, scope: effectiveScope(pinned), risk: pinned.riskFloor, checkouts,
      lanePrograms: laneOrder(now.spec).map((l) => ({ lane: l.id, argv0: l.argv[0]!, resolved: resolveArgv0(l, ctx.hostEnv) })),
      priorRound: planCheckPriorRound(ctx, unit.id, checkouts),
      // R17: the vision in force, read-only context (the module marks it non-directive).
      vision: visionInput(ctx),
      // E (R59): an efficient builder's check under `by-builder` maps acceptance clauses to witness items.
      acceptance: shape === 'acceptance' ? acceptanceOf(ctx, unit, now.spec, checkouts.tip.at) : null,
      priorInvalid: planCheckPriorInvalid(ctx, unit, now.spec),
      scopeGrowth: planCheckScopeGrowth(ctx, unit.id, effectiveScope(pinned), now.spec, checkouts.tip.at),
      escalation: escalationOf(ctx, unit.id, 'plan-check', seat.tier, validatePlanCheckOutput),
    });
    writeJudgmentInputs(ctx, parent, { tip: checkouts.tip.at, head: null, specRev: now.spec.rev, specSha256: now.sha256, routingRev: seat.routingRev });
    return { checkouts, rendered, target };
  });
  const { checkouts, rendered, target } = captured;
  const entered = await enterJudgment(ctx, parent);
  if (isCancelled(entered)) return entered;
  // Checkouts an earlier attempt left (a crash cut its stage short) go first: this attempt makes its own.
  await removePlanCheckCheckouts(ctx, unit.id, parent);
  await createPlanCheckCheckouts(ctx, unit.id, parent, checkouts);
  const dirs = [...(checkouts.branch === null ? [] : [checkouts.branch.path]), ledgerDir(ctx), ...targetDirs(target)];
  // 2026-10-15 (arc feedback #3): the acceptance shape's witness lanes are an enum of the arc lanes in force.
  const schema = shape === 'acceptance' ? planCheckAcceptanceSchemaFor(arcLanesOf(ctx)) : prompt.schema;
  const call = (s: JudgmentSession, text: string): Promise<BackendCallOutcome> => callBackend(ctx, {
    unit: unit.id, parent, request: { kind: 'judgment', dispatch: seat, session: s, evidenceDirs: dirs },
    system: prompt.system, rendered: text, schema, cwd: checkouts.tip.path, deadlineAt: inMs(judgmentDeadlineMs(pinned)),
  });
  const called = await call(session, rendered);
  // A refused answer goes back once, in the same session, with every reason (the repair turn), before anything is recorded.
  return planCheckRead(ctx, unit, parent, called, session.id, (reasons) => call(resumedJudgmentSession(session.id), judgmentRepairDirective(reasons)));
}

/**
 * A plan-check call's answer as the executor judges it (2026-10-15, arc feedback #3: one validator). `unanswered`: the
 * call gave no answer to judge (lost, a refusal, a fault, an interruption: `verdictOf` reads it). `refused`: every reason
 * the answer is unusable, together (its schema, then the vision clauses its conflicts cite, the contracts and rulings its
 * patch cites, and its patch: applied to the spec it judged and validated through the apply core). `answered`: usable.
 */
type PlanCheckJudged = Exclude<Judged<PlanCheckOutput>, Readonly<{ kind: 'answered' }>> | Readonly<{ kind: 'answered'; out: PlanCheckOutput; acceptance: boolean }>;

/**
 * A judgment call's answer against its schema, the first check of every role's repair turn (`repairTurnOf`, dispatch.ts).
 * `unanswered`: the call gave no answer to judge (lost, a refusal, a fault, an interruption, a backend park: `verdictOf`
 * reads it). `refused`: why the answer is off its schema (the adapter's check, then the role's validator). `answered`: the
 * validated answer, which the role may still refuse for its own reasons.
 */
export type Judged<T> =
  | Readonly<{ kind: 'unanswered' }>
  | Readonly<{ kind: 'refused'; reasons: readonly string[] }>
  | Readonly<{ kind: 'answered'; out: T }>;

export function judgedAnswer<T>(called: BackendCallOutcome, validate: (value: unknown) => T): Judged<T> {
  if (called.kind !== 'result') return { kind: 'unanswered' };
  const { outcome, backendErrors } = called.result;
  // A usage limit or capacity error is a backend park whatever else the call left (`verdictOf`).
  if (backendErrors.some((e) => (BACKEND_PARK_CLASSES as readonly string[]).includes(e.class))) return { kind: 'unanswered' };
  if (outcome.kind === 'malformed') return { kind: 'refused', reasons: [`the answer does not match its schema: ${outcome.detail}`] };
  if (outcome.kind !== 'success') return { kind: 'unanswered' };
  try {
    return { kind: 'answered', out: validate(outcome.value) };
  } catch (error) {
    if (error instanceof SchemaError) return { kind: 'refused', reasons: [`the answer is malformed: ${error.message}`] };
    throw error;
  }
}

/**
 * Judges plan-check call `called` of `unit`. `judged`: the spec it judged and the tip it read, for its patch; null when
 * this attempt already applied that patch (a crash after it), which is then not judged again. Scope growth: an answer
 * proposing growth code verifies is a hold, nothing else of it applied, so its patch (and the patch's cites) is not judged.
 */
function judgePlanCheck(ctx: StageContext, unit: PlanUnit, called: BackendCallOutcome, judged: Readonly<{ spec: SpecM1; tip: Sha }> | null): PlanCheckJudged {
  // E (R59): the acceptance shape's answer may only add or replace witness items and facts, and cite.
  const acceptance = called.kind === 'result' && called.result.outcome.kind === 'success' && isAcceptanceCall(ctx, called.inv);
  const answer = judgedAnswer(called, acceptance ? validatePlanCheckAcceptanceOutput : validatePlanCheckOutput);
  if (answer.kind !== 'answered') return answer;
  const out: PlanCheckOutput = answer.out;
  const reasons = [...visionCiteReasons(ctx, out)];
  const pinned = dispatchOf(ctx.journal.view, unit.id);
  const holds = judged !== null && verifiedGrowth(ctx, unit, judged.spec, effectiveScope(pinned), judged.tip, out.scopeGrowth).proposals.length > 0;
  if (!holds) reasons.push(...unknownCiteReasons(ctx, out.patch));
  if (out.patch !== null && judged !== null && !holds) {
    const by = { role: 'planCheck', routingRev: pinned.routingRev, inv: called.inv } as const;
    reasons.push(...patchReasons(ctx, unit, judged.spec, { expectRev: judged.spec.rev, by, ops: out.patch }));
  }
  return reasons.length === 0 ? { kind: 'answered', out, acceptance } : { kind: 'refused', reasons };
}

/** R17: each vision conflict cites only active clauses of the vision in force (and there is one). */
function visionCiteReasons(ctx: StageContext, out: PlanCheckOutput): readonly string[] {
  if (out.visionConflict.length === 0) return [];
  const active = new Set<string>((holisticInForce(ctx).vision?.clauses ?? []).filter((c) => c.state === 'active').map((c) => c.id));
  const unknown = [...new Set<string>(out.visionConflict.flatMap((v) => v.clauses.filter((c) => !active.has(c))))];
  if (unknown.length === 0) return [];
  return [`visionConflict cites ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} no active clause of the vision in force${active.size === 0 ? ' (there is none)' : ''}`];
}

/** A patch cites only plan contracts and ledger rulings. */
function unknownCiteReasons(ctx: StageContext, patch: PlanCheckOutput['patch']): readonly string[] {
  const rulings = new Set<string>(ledger(ctx).map((r) => r.id));
  const contracts = new Set<string>(ctx.plan().contracts);
  return (patch ?? []).flatMap((op) => (op.op === 'cite'
    ? [
      ...op.contracts.filter((c) => !contracts.has(c)).map((c) => `the patch cites contract ${c}, which is no plan contract`),
      ...op.rulings.filter((r) => !rulings.has(r)).map((r) => `the patch cites ruling ${r}, which the ledger does not hold`),
    ]
    : []));
}

/**
 * Why a redirect's patch of `spec` is not applied: it does not apply (ids that do not exist, or reused), or the patched
 * spec fails the apply core (`evaluateRevision` with proposer `plan-check`: the classifier's spec rows, among them lane
 * evidence, witness lanes and obligation witnesses, the census and the lane row) with a reason the spec in force does
 * not already have (a spec in force that breaks a rule is never refused for it here). Nothing is written.
 */
function patchReasons(ctx: StageContext, unit: PlanUnit, spec: SpecM1, patch: Parameters<typeof applySpecPatch>[1]): readonly string[] {
  let after: SpecM1;
  try {
    after = applySpecPatch(spec, patch);
  } catch (error) {
    if (error instanceof SpecPatchOpError || error instanceof SpecPatchStaleError) return [`the patch does not apply: ${error.message}`];
    throw error;
  }
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const current = inForceFiles(ctx.runDir, view, inForce, revisionInForce(ctx.runDir, inForce), ctx.planFile, ctx.repo);
  const rctx = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.hostEnv };
  const refused = (files: InputFiles): readonly string[] => {
    const v = evaluateRevision(rctx, files, { type: 'plan-check', unit: unit.id });
    return v.kind === 'rejected' ? v.reasons : [];
  };
  const had = new Set(refused(current));
  const file = current.specs.get(unit.id);
  if (file === undefined) throw new Error(`unit ${unit.id} is planned without a spec in force`);
  return refused({ ...current, specs: new Map(current.specs).set(unit.id, { path: file.path, bytes: specBytes(after) }) }).filter((r) => !had.has(r));
}

/**
 * Run 10 (C), every reason since 2026-10-15: why the unit's latest plan-check answer (its repair turn's, when it made
 * one) was refused, for the retry to correct; null when it was not, or the spec it judged is no longer in force.
 */
function planCheckPriorInvalid(ctx: StageContext, planUnit: PlanUnit, spec: SpecM1): string | null {
  const spawn = judgmentSpawns(ctx, planUnit.id, 'planCheck').at(-1);
  if (spawn === undefined || spawn.parent.type !== 'stage') return null;
  const inputs = ctx.journal.view.judgmentInputs(planUnit.id, 'plan-check', spawn.parent.attempt);
  const called = spawnCall(ctx, spawn);
  if (inputs === null || inputs.specRev !== spec.rev || called === null) return null;
  const judged = judgePlanCheck(ctx, planUnit, called, { spec, tip: inputs.tip });
  return judged.kind === 'refused' ? judged.reasons.join('; ') : null;
}

/**
 * Records a plan-check attempt from its call: the live one, or one recovery closed after a crash (consumed
 * by the driver, never asked again). Re-entrant: a spec patch or risk raise this attempt already made is
 * found in the log and not made twice, and the judgment is read against the spec revision it saw.
 *
 * 2026-10-15 (arc feedback #3): `repair` is the live attempt's repair turn. An answer `judgePlanCheck` refuses goes back
 * once, in the same session, with every reason, before anything is recorded; the repair turn's answer is then read as
 * the attempt's, and refused again it is `malformed` (the retry is told why: `planCheckPriorInvalid`). A call consumed
 * after a crash gets none (`repair` null): a crash between a refused answer and its repair turn records `malformed`.
 */
export async function planCheckRead(
  ctx: StageContext, unit: PlanUnit, parent: StageParent & Readonly<{ stage: 'plan-check' }>, called: BackendCallOutcome, session: JudgmentSessionId,
  repair: ((reasons: readonly string[]) => Promise<BackendCallOutcome>) | null = null,
): Promise<PlanCheckDone> {
  if (repair !== null) {
    const inputs = ctx.journal.view.judgmentInputs(unit.id, 'plan-check', parent.attempt);
    if (inputs === null) throw new Error(`plan-check ${unit.id}#${parent.attempt} has no judgment-inputs`);
    const first = judgePlanCheck(ctx, unit, called, { spec: loadUnitSpec(ctx, unit).spec, tip: inputs.tip });
    if (first.kind === 'refused') {
      const repaired = await repair(first.reasons);
      return planCheckRead(ctx, unit, parent, repaired, session);
    }
  }
  // The session has ended (or never ran): its checkouts and its @cpu go before anything is recorded.
  await removePlanCheckCheckouts(ctx, unit.id, parent);
  await releaseJudgment(ctx, parent);
  const { path, spec, sha256 } = loadUnitSpec(ctx, unit);
  const applied = attemptOps(ctx, parent, 'spec.patch').find((i) => ctx.journal.view.doneOf(i.op) !== null) ?? null;
  // The spec revision this judgment read: its captured inputs' (A19; captured before the `@cpu` wait, so the spec in
  // force may since carry an evidence-only edit, which keeps the rev). Its redirect patches the spec in force at that
  // rev; once patched, the spec in force is the next rev.
  const captured = ctx.journal.view.judgmentInputs(unit.id, 'plan-check', parent.attempt);
  if (captured === null) throw new Error(`plan-check ${unit.id}#${parent.attempt} has no judgment-inputs`);
  const specRev = captured.specRev;
  if (applied === null ? spec.rev !== specRev : applied.expect.expectRev !== specRev) {
    throw new Error(`plan-check ${unit.id}#${parent.attempt} judged spec rev ${specRev}, but ${applied === null ? `the spec in force is rev ${spec.rev}` : `its patch expects rev ${applied.expect.expectRev}`}`);
  }
  const seenSha256 = applied?.expect.oldSha256 ?? sha256;
  const pinned = dispatchOf(ctx.journal.view, unit.id);
  const done = (d: StageDone<'plan-check'>): PlanCheckDone => ({ ...d, session, specRev });
  const v = verdictOf(ctx, parent, called);
  if (v.kind !== 'success') return done(verdictKind(ctx, parent, v, called));

  // One validator (`judgePlanCheck`): an answer it refuses is an unusable judgment; nothing of it is recorded.
  const judged = judgePlanCheck(ctx, unit, called, applied === null ? { spec, tip: captured.tip } : null);
  if (judged.kind === 'refused') return done(record(ctx, parent, 'malformed'));
  if (judged.kind === 'unanswered') throw new Error(`${called.inv}: a successful plan-check call without an answer to judge`);
  const { out, acceptance } = judged;
  // R17: each vision conflict opens a P3 finding for the checkpoint (a re-read merges into it), whatever the decision; it
  // is never a redirect by itself.
  for (const c of out.visionConflict) openFinding(ctx.journal, visionConflictDraft({ unit: unit.id, attempt: parent.attempt, clauses: c.clauses, note: c.note }));
  // R2: the judgment may raise the floor, never lower it, and a redirect may not widen the envelope.
  if (riskAbove(pinned.riskFloor, out.risk)) return done(record(ctx, parent, 'risk-lowered'));
  // Scope growth (2026-10-15): a proposal code verifies holds the unit for the root agent, whatever the decision; nothing
  // else of the answer is applied (the plan-check runs again once the root agent has ruled).
  const growth = verifiedGrowth(ctx, unit, spec, effectiveScope(pinned), captured.tip, out.scopeGrowth);
  if (growth.proposals.length > 0) {
    const detail = { kind: 'scope-growth', proposals: growth.proposals } as const;
    return done(record(ctx, parent, 'scope-growth', scopeGrowthNeedsUser(ctx, unit, called, growth), NO_PARK_FACTS, undefined, detail));
  }
  if (widenedResources(unit, out.patch).length > 0) return done(record(ctx, parent, 'scope-widened'));
  const patch = out.patch === null ? null : { expectRev: specRev, by: { role: 'planCheck', routingRev: pinned.routingRev, inv: called.inv }, ops: out.patch } as const;
  if (riskAbove(out.risk, pinned.riskFloor)) raiseRisk(ctx, pinned, out.risk, { rev: specRev, sha256: seenSha256 });
  // A redirect beyond its bound escalates instead; only a redirect the table takes patches the spec.
  const redirects = outcomeFact(ctx.journal.view.unit(unit.id), { stage: 'plan-check', kind: 'redirect' }, parent.attempt).class === 'redirect';
  if (patch !== null && applied === null && redirects) {
    await machinePatch(ctx, unit.id, parent, { path, oldSha256: sha256, patch });
    if (acceptance) crashPoint('plancheck.after-witness-patch', unit.id);
  }
  return done(record(ctx, parent, out.decision));
}

// ---------------------------------------------------------------------------------------------------
// Scope growth (2026-10-15)

/**
 * What a plan-check reads for its proposals: Phase-0 row 10's scan of the spec's `removes` at the tip it checks (outside the
 * envelope `scope` and the spec's own scope), and the proposals the root agent rejected for the unit.
 */
function planCheckScopeGrowth(ctx: StageContext, unit: UnitId, scope: readonly RepoPattern[], spec: SpecM1, tip: Sha): PlanCheckScopeGrowth {
  const references = scopeReferences(ctx.repo, tip, unit, [...scope, ...spec.scope], specRemoves(spec)).map((r) => ({ removed: r.removed, referrers: r.referrers }));
  const rejected = ctx.journal.view.unit(unit).scopeDecisions.filter((d) => d.decision === 'rejected')
    .flatMap((d) => d.proposals.map((p) => ({ patterns: p.patterns, reason: p.reason, rejection: d.reason })));
  return { references, rejected };
}

/** A plan-check's proposals as code verified them: the patterns kept, per proposal, and why each other one was dropped. */
export type VerifiedGrowth = Readonly<{ proposals: readonly ScopeGrowthProposal[]; dropped: readonly string[] }>;

/**
 * Verifies each proposed pattern by the rules a ruled scope growth must pass, so the root agent is asked only what could
 * land: a repository pattern outside `.roadmap/`, outside the pinned envelope `scope` (`withinEnvelope`, the classifier's
 * re-entry rule), matching a file at the tip the plan-check read, covered by no lane's `evidenceGlobs` entry
 * (`evidenceScopeConflicts`, the classifier's), in a same-repo corpus arc clear of the corpus file set
 * (`scopeOverlapsCorpus`, the Phase-0 row's), and never one the root agent rejected for the unit. A proposal keeps the
 * patterns that pass; one left with none is dropped. (`scope accept` then runs the whole classifier on the revision.)
 */
function verifiedGrowth(ctx: StageContext, unit: PlanUnit, spec: SpecM1, scope: readonly RepoPattern[], tip: Sha, answers: PlanCheckOutput['scopeGrowth']): VerifiedGrowth {
  if (answers.length === 0) return { proposals: [], dropped: [] };
  const files = git(ctx.repo, ['ls-tree', '-r', '-z', '--name-only', tip]).split('\0').filter((f) => f !== '').map((f) => repoPath(f));
  const rejected = new Set(ctx.journal.view.unit(unit.id).scopeDecisions.filter((d) => d.decision === 'rejected').flatMap((d) => d.proposals.flatMap((p) => p.patterns)));
  const corpus = ctx.plan().target === 'corpus' ? corpusSet(ctx) : null;
  const dropped: string[] = [];
  const why = (raw: string): string | null => {
    let p: RepoPattern;
    try {
      p = repoPattern(raw, 'scopeGrowth.patterns');
    } catch (error) {
      if (error instanceof SchemaError) return 'not a repository pattern';
      throw error;
    }
    if (p === '.roadmap' || p.startsWith('.roadmap/')) return 'under .roadmap/, which no unit owns';
    if (withinEnvelope(p, scope)) return 'already inside the scope envelope';
    if (rejected.has(p)) return 'the root agent rejected it for this unit';
    if (!files.some((f) => matchesPattern(f, p))) return `matches no file at the integration tip ${tip}`;
    if (evidenceScopeConflicts(unit.id, [p], spec).length > 0) return 'a lane\'s evidenceGlobs entry covers it, so its content could never be committed';
    if (corpus !== null && scopeOverlapsCorpus(corpus, p)) return 'it may overlap the corpus file set';
    return null;
  };
  const proposals = answers.flatMap((a) => {
    const kept = [...new Set(a.patterns.filter((raw) => {
      const reason = why(raw);
      if (reason !== null) dropped.push(`\`${raw}\`: ${reason}`);
      return reason === null;
    }) as RepoPattern[])].sort();
    return kept.length === 0 ? [] : [{ patterns: kept, reason: a.reason }];
  });
  return { proposals, dropped };
}

/** A same-repo corpus arc's corpus file set in force; null for a corpus kept in another repository. */
function corpusSet(ctx: StageContext): ReturnType<typeof corpusFileSet> | null {
  const c = corpusInForce(ctx);
  const guide = readGuideBytes(c.guide.bytes).guide;
  return guide.source.kind === 'same-repo' ? corpusFileSet(c.pin.value, guide) : null;
}

/** The blocking item a scope-growth hold raises (the scheduler writes it, parented by the held attempt). */
function scopeGrowthNeedsUser(ctx: StageContext, unit: PlanUnit, called: BackendCallOutcome, growth: VerifiedGrowth): NeedsUserContent {
  const { path, spec } = loadUnitSpec(ctx, unit);
  const proposed = growth.proposals.map((p) => `${p.patterns.map((x) => `\`${x}\``).join(', ')} (${p.reason})`).join('; ');
  return {
    blocking: true,
    subject: { type: 'unit', unit: unit.id },
    reason: 'scope-growth',
    summary: `Unit ${unit.id}: its plan-check proposes growing its scope by ${proposed} (spec ${path} at rev ${spec.rev}).`
      + (growth.dropped.length === 0 ? '' : ` Code dropped: ${growth.dropped.join('; ')}.`),
    recommendation: `\`roadmap scope accept ${unit.id} --reason <text>\` lands the growth as one ruled revision (a new ruling naming the patterns, the unit's plan and spec scope widened) and re-runs the plan-check on it; `
      + `\`roadmap scope reject ${unit.id} --reason <text>\` keeps the scope, and the plan-check runs again told so (it decides within the scope, infeasible when the spec cannot be met).`,
    options: [],
    evidence: called.kind === 'result' ? [absPath(join(called.invDir, 'result.json'))] : [],
  };
}

/**
 * Scope growth (A): what each of the unit's done salvages reverted as outside the pinned scope, in log order, with the dir
 * keeping its content (`<run>/rejected/<unit>/<manifest sha256>/`, src/git/salvage.ts).
 */
export function salvageRejections(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>, unit: UnitId): readonly Readonly<{ paths: readonly RepoPath[]; dir: AbsPath }>[] {
  const view = ctx.journal.view;
  const root = absPath(join(ctx.runDir, 'rejected', unit));
  return view.opsOf('salvage.commit').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && view.doneOf(i.op) !== null).map((i) => {
    const dir = absPath(join(root, i.expect.rejectedManifestSha256));
    const checked = checkRejected(dir, i.expect.rejectedManifestSha256);
    if (checked.kind !== 'complete') throw new Error(`unit ${unit}: the rejected content of salvage ${i.op} at ${dir} is incomplete: ${checked.detail}`);
    return { paths: checked.manifest.entries.filter((e) => e.reason === 'out-of-scope').map((e) => e.path), dir };
  });
}

/**
 * Plan defects (2026-10-16): the paths both of the unit's last two salvages reverted as out of scope that could land as
 * scope growth (still outside the effective scope, never rejected by the root agent for the unit, covered by no lane's
 * `evidenceGlobs`, clear of a same-repo corpus), as one proposal with its blocking item; null when there are none.
 */
function repeatedReverts(ctx: StageContext, unit: PlanUnit, spec: SpecM1): Readonly<{ proposal: ScopeGrowthProposal; needsUser: NeedsUserContent }> | null {
  const salvages = salvageRejections(ctx, unit.id);
  if (salvages.length < 2) return null;
  const [previous, latest] = salvages.slice(-2) as [(typeof salvages)[number], (typeof salvages)[number]];
  const rejected = new Set<string>(ctx.journal.view.unit(unit.id).scopeDecisions.filter((d) => d.decision === 'rejected').flatMap((d) => d.proposals.flatMap((p) => p.patterns)));
  const corpus = ctx.plan().target === 'corpus' ? corpusSet(ctx) : null;
  const paths = stillOutside(ctx, unit.id, latest.paths).filter((p) => previous.paths.includes(p) && !rejected.has(p)
    && evidenceScopeConflicts(unit.id, [repoPattern(p)], spec).length === 0 && (corpus === null || !scopeOverlapsCorpus(corpus, repoPattern(p))));
  if (paths.length === 0) return null;
  const reason = `salvage reverted the unit's edits to ${paths.join(', ')} on its last two build rounds (outside its scope)`;
  const { path } = loadUnitSpec(ctx, unit);
  return {
    proposal: { patterns: paths.map((p) => repoPattern(p)), reason },
    needsUser: {
      blocking: true,
      subject: { type: 'unit', unit: unit.id },
      reason: 'scope-growth',
      summary: `Unit ${unit.id}: ${reason}, so its build needs ${paths.length === 1 ? 'that path' : 'those paths'} (spec ${path} at rev ${spec.rev}; the reverted versions are kept under ${latest.dir}/files).`,
      recommendation: `\`roadmap scope accept ${unit.id} --reason <text>\` lands the growth as one ruled revision and re-opens the unit at plan-check on it (its builder is told to restore the reverted versions); `
        + `\`roadmap scope reject ${unit.id} --reason <text>\` keeps the scope: the lanes run, and the build is told again that the paths are outside it.`,
      options: [],
      evidence: [latest.dir],
    },
  };
}

/** The paths of `paths` now inside the unit's effective scope (a scope accept took them in since), ascending. */
export const nowInside = (ctx: StageContext, unit: UnitId, paths: readonly RepoPath[]): readonly RepoPath[] => {
  const scope = effectiveScope(dispatchOf(ctx.journal.view, unit));
  return [...new Set(paths.filter((p) => scope.some((s) => matchesPattern(p, s))))].sort();
};

/** The paths of `paths` still outside the unit's effective scope (a scope accept since may have taken some in), ascending. */
export const stillOutside = (ctx: StageContext, unit: UnitId, paths: readonly RepoPath[]): readonly RepoPath[] => {
  const scope = effectiveScope(dispatchOf(ctx.journal.view, unit));
  return [...new Set(paths.filter((p) => !scope.some((s) => matchesPattern(p, s))))].sort();
};

/**
 * An executor's spec patch (a plan-check redirect, the implementer's decisions): a machine revision of the unit's spec,
 * so it holds the revision fence (A19, G2) and serialises with every other revision.
 */
async function machinePatch(ctx: StageContext, unit: UnitId, parent: StageParent, request: Parameters<ReturnType<typeof specPatchOp>['prepare']>[0]): Promise<void> {
  const hold = await holdFence(ctx.journal);
  try {
    await runOp(ctx.journal, specPatchOp(ctx.runDir), `spec:${unit}`, parent, request);
  } finally {
    hold.release();
  }
}

/** The ops of `kind` a stage attempt began, in log order. */
export function attemptOps<K extends OpKind>(ctx: StageContext, parent: StageParent, kind: K): readonly IntentOf<K>[] {
  const key = canonicalJson(parent);
  return ctx.journal.view.opsOf(kind).filter((i) => canonicalJson(i.parent) === key);
}

/**
 * The backend call a stage attempt made, read back from the log once recovery closed it: the attempt's
 * latest backend invocation with its result, or lost. Null when the attempt made none, or it is still open.
 */
export function recordedCall(ctx: StageContext, parent: StageParent): BackendCallOutcome | null {
  const spawn = attemptOps(ctx, parent, 'proc.spawn').filter((i) => i.expect.subject.purpose === 'backend').at(-1);
  return spawn === undefined ? null : spawnCall(ctx, spawn);
}

/** A backend spawn's call, read back from the log once recovery closed it: its result, or lost; null while it is open. */
export function spawnCall(ctx: StageContext, spawn: IntentOf<'proc.spawn'>): BackendCallOutcome | null {
  const done = ctx.journal.view.doneOf(spawn.op);
  if (done === null || done.kind !== 'proc.spawn') return null;
  const inv = invocationId(spawn.op, spawn.ordinal);
  const invDir = invocationDir(ctx.runDir, inv);
  if (done.outcome.kind === 'lost') return { kind: 'lost', inv, invDir, treeEffects: done.outcome.treeEffects };
  const result = runnerFiles(invDir, inv).read('result.json');
  if (result === null || result.type !== 'backend') throw new Error(`${inv}: a done backend spawn without its backend result`);
  return { kind: 'result', inv, invDir, result };
}

// ---------------------------------------------------------------------------------------------------
// build

/** What the stages after a successful build work on. */
export type BuildRun = Readonly<{
  inv: InvocationId;
  invDir: AbsPath;
  worktree: AbsPath;
  branch: RefName;
  /** The implementer's evidence dir (decisions.json). */
  workDir: AbsPath;
  /** The build's entry reservation, held from reserve to teardown; null when it reserved nothing. */
  reservation: Reservation<'running', StageHolder> | null;
}>;

export type BuildDone = StageDone<'build'> & Readonly<{ run: BuildRun | null }>;

const activeFastLanes = (spec: SpecM1): readonly FastLane[] =>
  fastLanes(spec).filter((l) => l.state === 'active') as readonly (FastLane & Readonly<{ state: 'active' }>)[];

/** The fast lane ids a build call's answer may name (I3): its schema's enum, and its reader's (null: none declared). */
export const buildLaneIds = (spec: SpecM1): readonly LaneId[] | null => {
  const ids = activeFastLanes(spec).map((l) => l.id);
  return ids.length === 0 ? null : ids;
};

// ---------------------------------------------------------------------------------------------------
// In-session assessment (M4a rev 3, E, Q18, R55)

/** The schema file an assess call's launch names (`inputFile` keeps every call's schema content-addressed). */
const assessSchemaPath = (runDir: AbsPath): AbsPath =>
  inputPath(runDir, bytesSha256(Buffer.from(`${canonicalJson(PLAN_ASSESSMENT_SCHEMA)}\n`, 'utf8')), 'schema.json');

/** Whether build invocation `inv` was an in-session assessment: its launch names the assessment's schema. */
export function isAssessCall(ctx: Readonly<{ runDir: AbsPath }>, inv: InvocationId): boolean {
  const launch = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('launch.json');
  if (launch === null) throw new Error(`${inv}: a build invocation without its launch.json`);
  return launch.terminal.type === 'backend' && launch.terminal.schemaPath === assessSchemaPath(ctx.runDir);
}

/** The latest backend spawn of a build attempt that was an assessment, or null. */
function attemptAssess(ctx: StageContext, parent: StageParent): IntentOf<'proc.spawn'> | null {
  return attemptOps(ctx, parent, 'proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && isAssessCall(ctx, invocationId(i.op, i.ordinal))).at(-1) ?? null;
}

/**
 * Whether the fresh build the decision `u.decided` asks for assesses in session first (R55): the unit's plan-check
 * decided `in-session`, or its last build attempt's malformed answer was the assessment (its retry assesses again).
 */
function assesses(ctx: StageContext, unit: UnitId): boolean {
  const d = ctx.journal.view.unit(unit).decided;
  if (d === null) return false;
  if (d.stage === 'plan-check') return d.outcome === 'in-session';
  if (d.stage !== 'build' || d.outcome !== 'malformed') return false;
  const last = recordedCall(ctx, { type: 'stage', unit, stage: 'build', attempt: d.attempt });
  return last !== null && isAssessCall(ctx, last.inv);
}

/**
 * The assessment a crash left unread: the build attempt just before `parent`, cut short (no outcome records it), whose
 * assess call completed. Consumed against what it answered, never asked again (crash table, "Build assess").
 */
function crashedAssessment(ctx: StageContext, parent: StageParent): IntentOf<'proc.spawn'> | null {
  const crashed = parent.attempt - 1;
  const u = ctx.journal.view.unit(parent.unit);
  if (u.decided?.attempt === crashed || u.interrupted?.attempt === crashed) return null;
  const assess = attemptAssess(ctx, { type: 'stage', unit: parent.unit, stage: 'build', attempt: crashed });
  return assess !== null && ctx.journal.view.doneOf(assess.op)?.outcome.kind === 'result' ? assess : null;
}

/** A tree's state an assessment must leave as it found it: HEAD and every tracked or unignored change. */
const treeState = (worktree: AbsPath): string => `${revParse(worktree, 'HEAD')}\n${dirtyPaths(worktree).join('\n')}`;

/** What an assessment decided: go on to implement in its session, or the attempt's outcome. */
type Assessed = Readonly<{ kind: 'implement'; session: ImplementerSessionId }> | Readonly<{ kind: 'done'; done: BuildDone }>;

/**
 * Reads an assessment (R55): a vision conflict opens a P3 finding (`source: stage{build}`), a risk floor below the pin is
 * malformed and one above raises the unit's risk (onto another implementer seat: `risk-raised`), `feasible: false` is
 * `infeasible{notes}`. Re-entrant: a raise or a finding a crashed attempt already made is not made twice.
 */
async function readAssessment(
  ctx: StageContext, unit: PlanUnit, parent: StageParent & Readonly<{ stage: 'build' }>, called: BackendCallOutcome, before: string | null,
  dispatch: ImplementerDispatch, held: Reservation<'running', StageHolder> | null,
): Promise<Assessed> {
  const fail = async (kind: StageOutcomeKind<'build'> | null, detail?: StageOutcomeDetail): Promise<Assessed> => {
    const cleaned = held === null ? null : await cleanup(ctx, held, parent);
    if (cleaned?.kind === 'cleanup-failed') return { kind: 'done', done: { ...record(ctx, parent, 'cleanup-failed', null, failedFacts(cleaned.failed)), run: null } };
    if (kind !== null) return { kind: 'done', done: { ...record(ctx, parent, kind, null, NO_PARK_FACTS, undefined, detail), run: null } };
    if (called.kind === 'lost') return { kind: 'done', done: { ...record(ctx, parent, 'lost', null, { backend: backendOf(called), failed: [] }), run: null } };
    const v = verdictOf(ctx, parent, called);
    if (v.kind === 'success') throw new Error(`${parent.unit} build#${parent.attempt}: an assessment's success read as a failure`);
    return { kind: 'done', done: { ...verdictKind(ctx, parent, v, called), run: null } };
  };
  // An assessment that never got as far as an answer (lost, a fault, a refusal) is the attempt's outcome as a build's would be.
  if (called.kind === 'lost') return fail(null);
  const v = verdictOf(ctx, parent, called);
  if (v.kind !== 'success') return fail(null);
  let out: PlanAssessmentOutput;
  try {
    out = validatePlanAssessment(v.value);
  } catch (error) {
    if (error instanceof SchemaError) return fail('malformed');
    throw error;
  }
  const worktree = unitWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id);
  if (before !== null && treeState(worktree) !== before) return fail('malformed');
  const a = out.planAssessment;
  if (a.visionConflict.length > 0) {
    const active = new Set((holisticInForce(ctx).vision?.clauses ?? []).filter((c) => c.state === 'active').map((c) => c.id));
    if (a.visionConflict.some((c) => c.clauses.some((id) => !active.has(id)))) return fail('malformed');
    for (const c of a.visionConflict) {
      const draft = visionConflictDraft({ unit: unit.id, attempt: parent.attempt, clauses: c.clauses, note: c.note });
      openFinding(ctx.journal, { ...draft, source: { type: 'stage', unit: unit.id, stage: 'build', attempt: parent.attempt } });
    }
  }
  const pinned = dispatchOf(ctx.journal.view, unit.id);
  if (riskAbove(pinned.riskFloor, a.riskFloor)) return fail('malformed');
  if (!a.feasible) return fail('infeasible', { kind: 'infeasible', notes: a.notes });
  if (riskAbove(a.riskFloor, pinned.riskFloor)) {
    const { spec, sha256 } = loadUnitSpec(ctx, unit);
    raiseRisk(ctx, pinned, a.riskFloor, { rev: spec.rev, sha256 });
  }
  crashPoint('build.after-assess', unit.id);
  // A raised floor whose implementer seat binds another model or backend: a fresh build there (a session cannot move).
  const reseated = implementerDispatch(ctx, unit.id);
  if (reseated.kind !== 'pinned' || !sameSession(reseated.dispatch.triple, dispatch.triple)) return fail('risk-raised');
  const session = invocationSession(ctx, called.inv);
  if (session === null) return fail('malformed');
  return { kind: 'implement', session };
}

export async function build(ctx: StageContext, unit: PlanUnit, input: RoundInput): Promise<BuildDone | Cancelled> {
  const parent = at(start(ctx, unit.id, 'build'), 'build');
  const entered = await enter(ctx, stageHolder(parent), buildEntry(ctx, unit));
  if (isCancelled(entered)) return entered;
  const failed = (d: StageDone<'build'>): BuildDone => ({ ...d, run: null });
  const held = await holdEntry(ctx, parent);
  if (held.kind === 'occupied') return failed(record(ctx, parent, 'occupied', held.needsUser));
  if (held.kind === 'cleanup-failed') return failed(record(ctx, parent, 'cleanup-failed', null, failedFacts(held.failed)));
  // G1: a stalled fix round moves the seat to build.high before the seat is chosen.
  escalateImplementer(ctx, unit.id, parent.attempt, input);
  // A steer round's session is fresh, so its seat re-pins whatever moved (R11, `steer --class`).
  const seated: Pinned<ImplementerDispatch> = input.kind === 'steer' ? { kind: 'pinned', dispatch: steerDispatch(ctx, unit.id) } : implementerDispatch(ctx, unit.id);
  if (seated.kind !== 'pinned') {
    const cleaned = held.reservation === null ? null : await cleanup(ctx, held.reservation, parent);
    if (cleaned?.kind === 'cleanup-failed') return failed(record(ctx, parent, 'cleanup-failed', null, failedFacts(cleaned.failed)));
    return failed(record(ctx, parent, 'routing-changed', seated.needsUser));
  }
  const { spec } = loadUnitSpec(ctx, unit);
  // 2026-10-15: a required witness on no arc lane in force has no lane file to publish; the unit parks before its call.
  const lanePark = witnessLanePark(ctx, unit, spec);
  if (lanePark !== null) {
    const cleaned = held.reservation === null ? null : await cleanup(ctx, held.reservation, parent);
    if (cleaned?.kind === 'cleanup-failed') return failed(record(ctx, parent, 'cleanup-failed', null, failedFacts(cleaned.failed)));
    return failed(record(ctx, parent, 'witness-lane-missing', lanePark));
  }
  const dispatch = seated.dispatch;
  const pinned = dispatchOf(ctx.journal.view, unit.id);
  // E (R55): a fresh build after an `in-session` plan-check assesses first. An assessment a pause interrupted is asked
  // again from the start (its continue would resume a read-only session as the build).
  const assessing = decidedRound(input) === 'fresh' && assesses(ctx, unit.id) && (input.kind !== 'continue' || isAssessCall(ctx, input.interrupted));
  const round = await prepareRound(ctx, dispatch, assessing && input.kind === 'continue' ? input.of : input, parent);

  const work = workDir(ctx.runDir, parent);
  durableMkdir(work);
  const prompt = promptFor('build', dispatch.triple.model);
  const lib = library(ctx, spec, integrationTip(ctx));
  // D1 (R56): the lane files of the fast required witness lanes, published before the call, and their commands.
  const witnessChecks = checksApply(ctx) ? publishWitnessLaneFiles(ctx, unit, work, requiredAt(ctx, unit, revParse(round.worktree, 'HEAD'))) : [];
  const lanes = buildLaneIds(spec);
  const render = (fixRound: RoundCall['fixRound'], assess: BuildAssess | null): string => prompt.render({
    spec: { unit: unit.id, rev: spec.rev, markdown: renderSpec(spec, { fastLanesOnly: true }) }, ...lib,
    planCheckNotes: planCheckNotes(ctx, unit.id),
    fastLanes: activeFastLanes(spec), suiteLanes: fastSuiteLanes(ctx.plan().suite.lanes, spec), evidenceDir: work, worktree: round.worktree, scope: effectiveScope(pinned),
    fixRound, witnessChecks, assess,
  });
  const callFor = (call: RoundCall): BackendCallSpec => ({
    unit: unit.id, parent,
    request: { kind: 'implementer', dispatch, session: call.session, evidenceDirs: [work, ...call.evidenceDirs, ledgerDir(ctx)] },
    system: prompt.system, rendered: render(call.fixRound, null), schema: buildSchemaFor(lanes), cwd: round.worktree, deadlineAt: round.deadlineAt,
  });
  if (!assessing) return buildRead(ctx, unit, parent, decidedRound(input), await callRound(ctx, round, callFor), held.reservation);

  // 1. assess: a fresh, read-only session answering PLAN_ASSESSMENT_SCHEMA (or the one a crash left unread).
  const crashed = crashedAssessment(ctx, parent);
  let assessed: Assessed;
  if (crashed !== null) {
    // The assessment's own call (a later implementing call of that attempt may have been lost).
    const called = spawnCall(ctx, crashed);
    if (called === null) throw new Error(`${unit.id} build#${parent.attempt}: the crashed assessment ${crashed.op} is still open`);
    assessed = await readAssessment(ctx, unit, parent, called, null, dispatch, held.reservation);
  } else {
    const before = treeState(round.worktree);
    const called = await callBackend(ctx, {
      unit: unit.id, parent,
      request: { kind: 'implementer', dispatch, session: freshSession(dispatch), evidenceDirs: [work, ledgerDir(ctx)] },
      system: prompt.system, rendered: render(null, { risk: pinned.riskFloor, vision: visionInput(ctx) }), schema: PLAN_ASSESSMENT_SCHEMA,
      cwd: round.worktree, deadlineAt: round.deadlineAt,
    });
    assessed = await readAssessment(ctx, unit, parent, called, before, dispatch, held.reservation);
  }
  if (assessed.kind === 'done') return assessed.done;
  // 2. implement: the same session resumed with the build's own ask (a reopen's respec directive after it).
  const fix = { failingEvidenceDirs: [], directives: [ASSESSED_DIRECTIVE, ...(round.fixRound?.directives ?? [])] };
  const implement = await callRound(ctx, { ...round, ...resumed(dispatch, assessed.session, fix, []) }, callFor);
  return buildRead(ctx, unit, parent, 'fresh', implement, held.reservation);
}

/**
 * Records a build attempt from its implementer call: the live one, or one recovery closed after a crash
 * (consumed by the driver, never dispatched again; lead ruling 14a/14b). `round` is the decided round (a
 * continue runs under the round it continues). `held` is the reservation the attempt still holds: the live
 * build's, or none once recovery has cleaned a dead holder's.
 */
export async function buildRead(
  ctx: StageContext, unit: PlanUnit, parent: StageParent & Readonly<{ stage: 'build' }>, round: BuildRound, called: BackendCallOutcome,
  held: Reservation<'running', StageHolder> | null,
): Promise<BuildDone> {
  const failed = (d: StageDone<'build'>): BuildDone => ({ ...d, run: null });
  const worktree = unitWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id);
  const branch = unitBranch(ctx.plan().arc, unit.id);
  if (called.kind === 'lost' && called.treeEffects) {
    // What the workload left is salvaged and verified like a report's (the plan's recovery table), uncharged.
    const run: BuildRun = { inv: called.inv, invDir: called.invDir, worktree, branch, workDir: workDir(ctx.runDir, parent), reservation: held };
    return { ...record(ctx, parent, 'lost-tree-effects'), run };
  }
  const v = verdictOf(ctx, parent, called);
  let malformed = false;
  if (v.kind === 'success') {
    try {
      buildOutputFor(buildLaneIds(loadUnitSpec(ctx, unit).spec))(v.value, 'build');
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
      malformed = true;
    }
  }
  // dev.12: a decisions.json that does not validate is part of a malformed report: the resume round quotes why
  // (src/pipeline/unit.ts `malformedError`), so the implementer rewrites it instead of the decisions being lost.
  if (v.kind === 'success' && !malformed) malformed = typeof readDecisions(absPath(join(workDir(ctx.runDir, parent), DECISIONS_FILE)), loadUnitSpec(ctx, unit).spec) === 'string';
  // A resolve round must end with the merge committed: HEAD with parents [old, T] (mergeinCompleted). A
  // report of success without it does not describe the tree, so it is read as a malformed report.
  if (v.kind === 'success' && !malformed && round === 'resolve') malformed = !mergeinResolved(ctx, unit.id);
  if (v.kind === 'success' && !malformed && called.kind === 'result') {
    const run: BuildRun = { inv: called.inv, invDir: called.invDir, worktree, branch, workDir: workDir(ctx.runDir, parent), reservation: held };
    return { ...record(ctx, parent, 'success'), run };
  }
  // Nothing downstream runs after a failed build, so its resources are cleaned now (the workload is quiescent).
  const cleaned = held === null ? null : await cleanup(ctx, held, parent);
  if (cleaned?.kind === 'cleanup-failed') return failed(record(ctx, parent, 'cleanup-failed', null, failedFacts(cleaned.failed)));
  // Lost again after its retry, with no effect on the tree.
  if (called.kind === 'lost') return failed(record(ctx, parent, 'lost', null, { backend: backendOf(called), failed: [] }));
  return failed(v.kind === 'success' ? record(ctx, parent, 'malformed') : verdictKind(ctx, parent, v, called));
}

/** The unit's latest merge-in: the conflicted one a resolve round resolves. */
export function latestMergein(ctx: StageContext, unit: UnitId): IntentOf<'mergein.prepare'> | null {
  return ctx.journal.view.opsOf('mergein.prepare').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit).at(-1) ?? null;
}

/**
 * Whether a resolve round left the merge-in committed: HEAD the merge of [old, T], or (8d) descending from it through
 * the implementer's own non-merge commits (`resolvedHead`).
 */
function mergeinResolved(ctx: StageContext, unit: UnitId): boolean {
  const intent = latestMergein(ctx, unit);
  if (intent === null) throw new Error(`a resolve round of ${unit} without a merge-in`);
  return resolvedHead(intent) !== null;
}

// ---------------------------------------------------------------------------------------------------
// quiesce → evidence → salvage → teardown

export function quiesce(ctx: StageContext, unit: UnitId, run: BuildRun): StageDone<'quiesce'> {
  const parent = at(start(ctx, unit, 'quiesce'), 'quiesce');
  // invoke settles only once the workload is empty (R13); this re-checks every ordinal of the op.
  if (!quiescent(ctx, { inv: run.inv, scope: 'op', reason: 'recovery' })) throw new Error(`build ${run.inv} of ${unit} has live workload members after it settled`);
  return record(ctx, parent, 'empty');
}

export type EvidenceDone = StageDone<'evidence'> & Readonly<{ evidence: readonly AbsPath[] }>;

const unique = (patterns: readonly RepoPattern[]): readonly RepoPattern[] => [...new Set(patterns)].sort();

export async function evidence(ctx: StageContext, unit: PlanUnit, run: BuildRun): Promise<EvidenceDone> {
  const { spec } = loadUnitSpec(ctx, unit);
  const parent = at(start(ctx, unit.id, 'evidence'), 'evidence');
  const root = evidenceRoot(ctx.runDir, parent);
  const inv = relative(ctx.runDir, run.invDir);
  const work = relative(ctx.runDir, run.workDir);
  const dirs: AbsPath[] = [absPath(join(root, 'build'))];
  await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${unit.id}`, parent, {
    source: ctx.runDir, globs: [`${inv}/stdout`, `${inv}/stderr`, `${work}/**`].map((g) => repoPattern(g)), dest: dirs[0]!,
  });
  const globs = unique(activeFastLanes(spec).flatMap((l) => l.evidenceGlobs));
  if (globs.length > 0) {
    dirs.push(absPath(join(root, 'tree')));
    await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${unit.id}`, parent, { source: run.worktree, globs, dest: dirs[1]! });
  }
  await appendDecisions(ctx, unit, run, absPath(join(dirs[0]!, FILES_DIR, work, DECISIONS_FILE)), parent);
  return { ...record(ctx, parent, 'captured'), evidence: dirs };
}

/**
 * The implementer's decisions.json at `file`: its validated content, null when it was not written, or why it does not
 * validate (a build whose report validates but whose decisions.json does not is malformed: `buildRead`). An entry is a
 * decision of `spec`'s: a new id, or an active decision restated; one naming a lane, an acceptance clause or a fact, or a
 * decision struck or deferred, does not validate (dev.12: never skipped silently).
 */
export function readDecisions(file: AbsPath, spec: SpecM1): DecisionsFile | string | null {
  if (!existsSync(file)) return null;
  let decisions: DecisionsFile;
  try {
    decisions = validateDecisionsFile(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof SchemaError)) throw error;
    return `${DECISIONS_FILE} does not validate: ${error.message}`;
  }
  const kinds: readonly (readonly [string, readonly Readonly<{ id: string }>[]])[] = [['a lane', spec.lanes], ['an acceptance clause', spec.acceptance], ['a fact', spec.facts]];
  const faults = decisions.decisions.flatMap((d) => {
    const named = kinds.find(([, items]) => items.some((i) => i.id === d.id));
    if (named !== undefined) return [`${d.id} is ${named[0]} of the spec, not a decision`];
    const decided = spec.decisions.find((i) => i.id === d.id);
    return decided !== undefined && decided.state !== 'active' ? [`decision ${d.id} is ${decided.state}; a new decision takes a new id`] : [];
  });
  return faults.length === 0 ? decisions : `${DECISIONS_FILE} does not validate: ${faults.join('; ')}`;
}

/**
 * The implementer's decisions.json, as captured by the snapshot, appended to the spec's decisions section
 * (lead ruling, step 12): one `spec.patch` by the executor, so the gate grades against every decision taken
 * and the new revision is part of the approval fingerprint. A new id is added, a decision restated with new
 * text replaces the active one, a decision restated verbatim is already there. A file that does not validate
 * (`readDecisions`, an entry naming an item that is not an active decision among its causes) reaches here only from a
 * build with no report to refuse (lost with tree effects) or one a previous release read (`buildRead` makes any other
 * malformed): it is not appended, and a stderr line names it.
 * Nor is anything appended while the architect's revision of the spec is pending (`UnitState.pendingRevision`): the
 * unit re-opens on that revision at its next boundary that allows it, and its next build writes its decisions again.
 */
async function appendDecisions(ctx: StageContext, unit: PlanUnit, run: BuildRun, file: AbsPath, parent: StageParent): Promise<void> {
  const { path, spec, sha256 } = loadUnitSpec(ctx, unit);
  const decisions = readDecisions(file, spec);
  if (decisions === null) return;
  if (typeof decisions === 'string') {
    process.stderr.write(`roadmap: ${unit.id} ${parent.stage}#${parent.attempt}: ${file} not appended to the spec: ${decisions}\n`);
    return;
  }
  if (ctx.journal.view.unit(unit.id).pendingRevision !== null) return;
  const ops = decisions.decisions.flatMap((d): SpecPatchOp[] => {
    const decided = spec.decisions.find((i) => i.id === d.id);
    if (decided === undefined) return [{ op: 'add', section: 'decisions', item: d }];
    return decided.text === d.text ? [] : [{ op: 'replace', section: 'decisions', item: d }];
  });
  if (ops.length === 0) return;
  await machinePatch(ctx, unit.id, parent, { path, oldSha256: sha256, patch: { expectRev: spec.rev, by: { role: 'executor', inv: run.inv }, ops } });
}

export type SalvageDone = StageDone<'salvage'> & Readonly<{ sha: Sha | null }>;

const EXECUTOR = { name: 'Roadmap Executor', email: 'executor@roadmap.invalid' } as const;

/** The identity of every commit the executor makes (salvage, merge-in, candidate, snapshot), dated now. */
export function executorIdentity(): Identity {
  const date = gitDate(`${Math.floor(Date.now() / 1000)} +0000`);
  return { author: { ...EXECUTOR, date }, committer: { ...EXECUTOR, date } };
}

export async function salvage(ctx: StageContext, unit: PlanUnit, run: BuildRun): Promise<SalvageDone> {
  const { spec } = loadUnitSpec(ctx, unit);
  const pinned = dispatchOf(ctx.journal.view, unit.id);
  const parent = at(start(ctx, unit.id, 'salvage'), 'salvage');
  const rules: SalvageRules = {
    scope: effectiveScope(pinned),
    excluded: unique(spec.lanes.flatMap((l) => l.evidenceGlobs)),
    rejectedRoot: absPath(join(ctx.runDir, 'rejected', unit.id)),
  };
  const request = {
    worktree: run.worktree, branch: run.branch,
    identity: executorIdentity(),
    message: `roadmap ${ctx.plan().arc}: salvage of unit ${unit.id} (build ${run.inv})\n`,
  };
  const op = salvageCommitOp(rules);
  let prepared;
  try {
    // A merge left in progress (a resolve round that never committed) is never salvaged as a plain commit.
    if (mergeHead(run.worktree) !== null) throw new SalvageUnmergedError(run.worktree, [repoPath('MERGE_HEAD')]);
    const decision = planSalvage(rules, request);
    prepared = decision.kind === 'no-change' ? null : await op.prepare(decision.plan);
  } catch (error) {
    const kind = error instanceof SalvageUnmergedError ? 'unmerged'
      : error instanceof SalvageStateError || error instanceof GitError ? 'commit-failed' : null;
    if (kind === null) throw error;
    // Refused before any intent: the tree is untouched and preserved for the architect. The unit parks, so
    // teardown never runs: the build's resources are cleaned here (a failure leaves its residue durable), and
    // the instances it failed join the park's targets (G6).
    const cleaned = run.reservation === null ? null : await cleanup(ctx, run.reservation, parent);
    return { ...record(ctx, parent, kind, null, failedFacts(cleaned?.kind === 'cleanup-failed' ? cleaned.failed : [])), sha: null };
  }
  const next = prepared === null
    ? revParse(run.worktree, 'HEAD')
    : (await runPrepared(ctx.journal, op, `salvage:${unit.id}`, parent, prepared)).post.new;
  // A risk trigger when the unit's diff (merge-base with the integration tip, so what a merge-in brought
  // is not the unit's) touches any plan contract, cited or not, the architecture doc or its digest.
  const authority = authorityPaths(ctx);
  const touched = unitDiffPaths(ctx.repo, integrationTip(ctx), next).some((p) => authority.has(p));
  return { ...record(ctx, parent, touched ? 'committed-contract-touched' : 'committed'), sha: next };
}

export async function teardown(ctx: StageContext, unit: UnitId, run: BuildRun): Promise<StageDone<'teardown'>> {
  const parent = at(start(ctx, unit, 'teardown'), 'teardown');
  if (run.reservation === null) return record(ctx, parent, 'released');
  const cleaned = await cleanup(ctx, run.reservation, parent);
  return cleaned.kind === 'released' ? record(ctx, parent, 'released') : record(ctx, parent, 'cleanup-failed', null, failedFacts(cleaned.failed));
}

// ---------------------------------------------------------------------------------------------------
// lanes

export type LanesDone = StageDone<'lanes'> & Readonly<{
  /** The salvage SHA the lanes ran at. */
  at: Sha;
  /** Every lane that ran, in order: the gate's lane ledger. */
  ledger: readonly LaneRecord[];
  /** The checkout the gate reads, kept only when the gate is next; every other outcome removes it here. */
  verification: VerificationTree | null;
  /** The fix round a red or not-certified series calls for (rounds.ts), else null. */
  fix: DecidedRound | null;
}>;

/** Every lane's declared evidence, the unit's and the suite's: what a leftover checkout's removal captures. */
export function laneGlobs(ctx: StageContext, spec: SpecM1): readonly RepoPattern[] {
  return unique([...spec.lanes, ...ctx.plan().suite.lanes].flatMap((l) => l.evidenceGlobs));
}

/** How much of a red lane's stdout and stderr a known defect's `output` match reads: the tail. */
export const KNOWN_DEFECT_TAIL_BYTES = 64 * 1024;

/** The tail of an invocation's output file, as text (empty when the file is absent). */
function outputTail(path: string): string {
  if (!existsSync(path)) return '';
  const bytes = readFileSync(path);
  return bytes.subarray(Math.max(0, bytes.length - KNOWN_DEFECT_TAIL_BYTES)).toString('utf8');
}

/**
 * M4a rev 3 (F4, R49): the plan known defect this unit hits (its entry), or null. `lane` matches before any lane runs: an active entry
 * whose lane the unit's active spec declares. `output` matches a red lane of `ledger`: an active entry on that lane whose
 * `contains` is in the tail of the counted run's stdout or stderr. Activity is `knownDefectActive`'s alone.
 */
function knownDefectHit(ctx: StageContext, unit: PlanUnit, spec: SpecM1, ledger: readonly LaneRecord[] | null): KnownDefect | null {
  const plan = ctx.plan();
  const active = knownDefectsOf(plan).filter((k) => knownDefectActive(ctx.journal.view, plan, k, unit.id));
  for (const k of active) {
    if (ledger === null) {
      if (k.match.type === 'lane' && spec.lanes.some((l) => l.id === k.match.lane && l.state === 'active')) return k;
      continue;
    }
    if (k.match.type !== 'output') continue;
    const { contains } = k.match;
    const red = ledger.filter((l) => l.lane === k.match.lane && (l.verdict === 'fail' || l.verdict === 'stall'));
    const hit = red.some((l) => {
      const dir = invocationDir(ctx.runDir, l.inv);
      return outputTail(join(dir, STDOUT_FILE)).includes(contains) || outputTail(join(dir, STDERR_FILE)).includes(contains);
    });
    if (hit) return k;
  }
  return null;
}

/** What a lanes attempt records beyond the series' own outcome: the D1 and D2 checks', or a known defect's. */
type LanesVerdict = Readonly<{
  kind: StageOutcomeKind<'lanes'>; detail?: StageOutcomeDetail; needsUser?: NeedsUserContent; failed?: readonly ResourceInstance[]; cause?: HoldCause;
}>;

/**
 * The checks after a green certified spec series in a corpus arc (LR-h): witness presence (D1), then mutation smoke (D2).
 * Green when neither finds anything (or neither applies).
 */
async function executableChecks(ctx: StageContext, unit: PlanUnit, parent: StageParent, salvaged: Sha, rt: LaneRuntime): Promise<LanesVerdict> {
  const d1 = await witnessPresence(ctx, unit, parent, salvaged, rt);
  switch (d1.kind) {
    case 'skip':
      return { kind: 'green' };
    case 'witnesses-missing':
      return { kind: 'witnesses-missing', detail: { kind: 'witnesses-missing', missing: d1.missing, failed: d1.failed } };
    case 'plan-defect':
      return { kind: 'plan-defect', detail: { kind: 'plan-defect', defects: d1.defects }, needsUser: d1.needsUser };
    case 'not-certified':
    case 'blocked':
      return { kind: d1.kind };
    case 'interrupted':
      return { kind: 'interrupted' };
    case 'occupied':
      return { kind: 'occupied', needsUser: d1.needsUser };
    case 'cleanup-failed':
      return { kind: 'cleanup-failed', failed: d1.failed };
    case 'green':
      break;
  }
  const d2 = await mutationSmoke(ctx, unit, parent, salvaged, d1.required, rt);
  switch (d2.kind) {
    case 'not-run':
      return { kind: 'green' };
    case 'ran':
      return d2.verdict.survived.length === 0
        ? { kind: 'green' }
        : { kind: 'smoke-survived', detail: { kind: 'smoke-survived', obligations: survivingObligations(d2.targets, d2.verdict.survived), testIds: d2.verdict.survived } };
    case 'interrupted':
      return { kind: 'interrupted' };
    case 'occupied':
      return { kind: 'occupied', needsUser: d2.needsUser };
    case 'cleanup-failed':
      return { kind: 'cleanup-failed', failed: d2.failed };
  }
}

// ---------------------------------------------------------------------------------------------------
// The fast suite at the lanes stage (the 2026-10-15 batch)
//
// After a green certified spec series the lanes stage runs the plan's fast suite lanes (`fastSuiteLanes`: less those
// identical to a spec lane) at the salvage SHA, in their own detached checkout (`fastSuiteWorktree` `suite`), each under
// its own reservation, as `lane{set: suite}` spawns of the lanes attempt with evidence under `<attempt root>/_suite`. So a
// builder's lint or typecheck red is a fix round of its own build, not a candidate red. A failed fast suite (a red lane,
// or a changed checkout) runs again on the unit's diff base alone (`diffBase(T, salvage)`: what the unit built on), the
// red lane only (or, for a changed checkout, every lane that ran), under `<attempt root>/_base`. Base green: the unit's
// red, a chargeable fix round with the fast suite's evidence (`red`, or `not-certified` for a changed checkout). Base
// failed too: `base-red`, uncharged, on to the gate. The candidate stays the one place that decides a broken base: its
// suite runs on the current tip, so a tip that fixed the base since passes, and a tip still red is its `base-red` (merges
// halt, `needs-user`). A park here could not heal: the unit's commit never contains a later fix of its base, and only
// the candidate merges the tip. A base check's verdict is shared by every unit of the run (`BASE_CHECKS`): units red on
// the same lanes over the same base run it once.
//
// Regenerate checks (dev.12): the regenerate lane of each derived entry whose sources or outputs the unit's diff touches
// (`unitRegenerateLanes`, src/input/derived.ts) runs first in the same series, as a fast suite lane: a hand edit hidden in
// a regenerated output is the unit's red, a fix round whose evidence names each differing output and its difference. Red on
// the base too (the base's outputs do not regenerate either), it is `base-red` like any suite lane, and the gate is told
// the outputs went unverified (gate.ts `regeneratedChecks`).

/** Where a lanes attempt keeps the evidence of its fast suite: at the salvage SHA (`suite`), on the diff base alone (`base`). */
export const fastSuiteRoot = (runDir: AbsPath, parent: StageParent, at: 'suite' | 'base'): AbsPath => absPath(join(evidenceRoot(runDir, parent), `_${at}`));

/** The fast suite on the diff base alone: whether it failed (a red lane, or a changed checkout), or no verdict (what the attempt records). */
type BaseCheck =
  | Readonly<{ kind: 'verdict'; failed: boolean; lanes: readonly LaneId[]; changedCheckout: boolean }>
  | Readonly<{ kind: 'none'; verdict: LanesVerdict }>;

/**
 * Base checks per journal (one run), by base SHA and lanes: kept while they have a verdict. A unit asking while another's
 * check runs waits for it (a pause of the waiter takes effect after: the wait is that check's lanes); one without a
 * verdict (that unit paused, say) is dropped and the waiter runs its own.
 */
const BASE_CHECKS = new WeakMap<object, Map<string, Promise<BaseCheck>>>();

/** A fast suite series' end that is no product verdict, its host pressure read first (RC-11), else null. */
function suiteFault(ctx: StageContext, unit: UnitId, series: Series): LanesVerdict | null {
  const cause = pressureCause(seriesRuling(ctx.runDir, ctx.journal.view.unit(unit), series.end));
  if (cause !== null) return { kind: 'interrupted', cause };
  const { end } = series;
  switch (end.kind) {
    case 'green':
    case 'red':
      return null;
    case 'occupied':
      return { kind: 'occupied', needsUser: end.needsUser };
    case 'cleanup-failed':
      return { kind: 'cleanup-failed', failed: end.failed };
    case 'blocked':
    case 'interrupted':
      return { kind: end.kind };
  }
}

/** `lanes` at `at` in their own checkout, removed afterwards (citing the series' evidence). */
async function fastSuiteSeries(ctx: StageContext, parent: StageParent, lanes: readonly LaneDef[], at: Sha, which: 'suite' | 'base', rt: LaneRuntime): Promise<Series> {
  const { worktreeRoot, arc } = ctx.plan();
  const checkout = { path: fastSuiteWorktree(worktreeRoot, arc, parent.unit, parent.attempt, which), checkout: { type: 'detached', at } } as const;
  const series = await runLaneSeries(ctx, parent, lanes, 'suite', checkout, fastSuiteRoot(ctx.runDir, parent, which), rt, false);
  if (series.tree !== null) await removeVerificationTree(ctx, series.tree, parent);
  return series;
}

/** `lanes` on `base` alone, run once per run for every unit asking (a check without a verdict is not kept). */
async function baseCheck(ctx: StageContext, parent: StageParent, base: Sha, lanes: readonly LaneDef[], rt: LaneRuntime): Promise<BaseCheck> {
  const checks = BASE_CHECKS.get(ctx.journal) ?? new Map<string, Promise<BaseCheck>>();
  BASE_CHECKS.set(ctx.journal, checks);
  const key = canonicalJson({ base, lanes });
  const known = checks.get(key);
  if (known !== undefined) {
    const check = await known;
    if (check.kind === 'verdict') return check;
  }
  const running = (async (): Promise<BaseCheck> => {
    const series = await fastSuiteSeries(ctx, parent, lanes, base, 'base', rt);
    const fault = suiteFault(ctx, parent.unit, series);
    if (fault !== null) return { kind: 'none', verdict: fault };
    const red = series.end.kind === 'red' ? [series.end.lane.lane] : [];
    return { kind: 'verdict', failed: red.length > 0 || series.dirty.length > 0, lanes: red, changedCheckout: series.dirty.length > 0 };
  })();
  checks.set(key, running);
  const check = await running;
  if (check.kind !== 'verdict' && checks.get(key) === running) checks.delete(key);
  return check;
}

/** The fast suite after a green spec series: its verdict, and its series at the salvage SHA (null when it has no lane). */
async function fastSuite(
  ctx: StageContext, unit: PlanUnit, spec: SpecM1, parent: StageParent, salvaged: Sha, rt: LaneRuntime,
): Promise<Readonly<{ verdict: LanesVerdict; series: Series | null }>> {
  // dev.12: the regenerate checks of the derived entries the unit's diff touches go first (src/input/derived.ts).
  const regenerate = unitRegenerateLanes(ctx.plan(), unitDiffPaths(ctx.repo, integrationTip(ctx), salvaged));
  const lanes = [...regenerate, ...fastSuiteLanes(ctx.plan().suite.lanes, spec)];
  if (lanes.length === 0) return { verdict: { kind: 'green' }, series: null };
  const series = await fastSuiteSeries(ctx, parent, lanes, salvaged, 'suite', rt);
  const fault = suiteFault(ctx, unit.id, series);
  if (fault !== null) return { verdict: fault, series };
  const { end, dirty } = series;
  if (end.kind === 'green' && dirty.length === 0) return { verdict: { kind: 'green' }, series };
  // A series stops at its red lane, so that lane alone runs on the base; a changed checkout reruns every lane that ran.
  const failing = end.kind === 'red' ? lanes.filter((l) => l.id === end.lane.lane) : lanes.filter((l) => series.ledger.some((r) => r.lane === l.id));
  const base = diffBase(ctx.repo, integrationTip(ctx), salvaged);
  // A unit whose commit is its base (nothing of its own) failed on the base in this very run.
  const check: BaseCheck = base === salvaged
    ? { kind: 'verdict', failed: true, lanes: end.kind === 'red' ? [end.lane.lane] : [], changedCheckout: dirty.length > 0 }
    : await baseCheck(ctx, parent, base, failing, rt);
  if (check.kind === 'none') return { verdict: check.verdict, series };
  if (!check.failed) return { verdict: { kind: end.kind === 'red' ? 'red' : 'not-certified' }, series };
  return { verdict: { kind: 'base-red', detail: { kind: 'base-red', base, lanes: check.lanes, changedCheckout: check.changedCheckout } }, series };
}

export async function lanes(ctx: StageContext, unit: PlanUnit, salvaged: Sha): Promise<LanesDone | Cancelled> {
  const { spec } = loadUnitSpec(ctx, unit);
  const order = laneOrder(spec);
  const parent = at(start(ctx, unit.id, 'lanes'), 'lanes');
  // F4: a known defect matched by lane holds the unit before anything runs (uncharged; it waits at prepare).
  const cancelled = cancelledNow(ctx);
  if (cancelled !== null) return cancelled;
  const held = knownDefectHit(ctx, unit, spec, null);
  if (held !== null) {
    return { ...record(ctx, parent, 'known-defect', null, NO_PARK_FACTS, undefined, { kind: 'known-defect', id: held.id, match: held.match }), at: salvaged, ledger: [], verification: null, fix: null };
  }
  // 2026-10-15: a required witness on no arc lane in force can never be checked; the unit parks before anything runs.
  const lanePark = witnessLanePark(ctx, unit, spec);
  if (lanePark !== null) return { ...record(ctx, parent, 'witness-lane-missing', lanePark), at: salvaged, ledger: [], verification: null, fix: null };
  // Plan defects (2026-10-16): the same out-of-scope path reverted on two build rounds running holds the unit for the root agent.
  const reverted = repeatedReverts(ctx, unit, spec);
  if (reverted !== null) {
    return { ...record(ctx, parent, 'scope-growth', reverted.needsUser, NO_PARK_FACTS, undefined, { kind: 'scope-growth', proposals: [reverted.proposal] }), at: salvaged, ledger: [], verification: null, fix: null };
  }
  const entry = seriesEntry(ctx, order);
  const entered = await enter(ctx, stageHolder(parent), entry);
  if (isCancelled(entered)) return entered;
  // A checkout an earlier attempt left (a crash cut its stage short) goes first: this series makes its own.
  for (const created of presentCheckouts(ctx.journal.view, unit.id)) await removeCheckout(ctx, created, parent, laneGlobs(ctx, spec));
  const checkout = { path: verificationWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id, parent.attempt), checkout: { type: 'detached', at: salvaged } } as const;
  const rt = laneRuntime(ctx, unit.id);
  const series = await runLaneSeries(ctx, parent, order, 'spec', checkout, specSeriesRoot(ctx.runDir, parent), rt, entry !== null);
  const { end } = series;
  let verdict: LanesVerdict = end.kind === 'green' ? { kind: series.dirty.length > 0 ? 'not-certified' : 'green' }
    : end.kind === 'occupied' ? { kind: 'occupied', needsUser: end.needsUser }
    : end.kind === 'cleanup-failed' ? { kind: 'cleanup-failed', failed: end.failed }
    : { kind: end.kind };
  // M4b rev 3 (RC-11): a lane its watchdog ended under host pressure is starved, and a red one under it reruns once: a
  // hold with cause `host-pressure`, uncharged (starved.ts), before any other reading of the red.
  const cause = pressureCause(seriesRuling(ctx.runDir, ctx.journal.view.unit(unit.id), end));
  if (cause !== null) verdict = { kind: 'interrupted', cause };
  // F4: a red lane whose output names a known defect is that defect (uncharged), not a red series.
  if (verdict.kind === 'red') {
    const hit = knownDefectHit(ctx, unit, spec, series.ledger);
    if (hit !== null) verdict = { kind: 'known-defect', detail: { kind: 'known-defect', id: hit.id, match: hit.match } };
  }
  // The fast suite lanes (the 2026-10-15 batch): only after a green certified spec series.
  const suite = verdict.kind === 'green' ? await fastSuite(ctx, unit, spec, parent, salvaged, rt) : null;
  if (suite !== null) verdict = suite.verdict;
  // D1, D2 (corpus arcs): only after a green certified spec series and a fast suite that passed or was the base's red.
  if ((verdict.kind === 'green' || verdict.kind === 'base-red') && checksApply(ctx)) {
    const checks = await executableChecks(ctx, unit, parent, salvaged, rt);
    if (checks.kind !== 'green') verdict = checks;
  }
  const kind = verdict.kind;
  // The gate reads the verification checkout: kept only when the gate is next (green, or survivors past the smoke bound).
  const next = transition(ctx.journal.view.unit(unit.id), { stage: 'lanes', kind });
  const keep = next.kind === 'stage' && next.stage === 'gate' ? series.tree : null;
  if (series.tree !== null && keep === null) await removeVerificationTree(ctx, series.tree, parent);
  // A fix round reads the spec series and the fast suite at the salvage SHA (`lanesFixRound`, unit.ts, rebuilds the same).
  const ledger = [...series.ledger, ...(suite?.series?.ledger ?? [])];
  const dirty = [...series.dirty, ...(suite?.series?.dirty ?? [])];
  const fix = kind === 'red' || (kind === 'not-certified' && dirty.length > 0) ? laneFixRound(ledger, dirty, salvaged) : null;
  const facts = failedFacts(verdict.failed ?? []);
  return { ...record(ctx, parent, kind, verdict.needsUser ?? null, facts, verdict.cause, verdict.detail), at: salvaged, ledger: series.ledger, verification: keep, fix };
}
