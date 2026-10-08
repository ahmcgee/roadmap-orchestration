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
// operator with an `env-blocked` item, and a hold carries its backend-park cause (G5).
//
//   plan-check  fresh judgment session (never a resume) → approve | redirect (spec.patch, rev+1) |
//               infeasible | escalate; a redirect may neither lower the risk floor nor widen the unit's
//               envelope, and may cite only plan contracts and ledger rulings; a raised risk re-pins the
//               dispatch record. The session reads detached checkouts of the integration tip (its cwd) and
//               of the unit branch when one exists, created for the attempt and removed when it is read. The
//               answer is read against the spec rev its `judgment-inputs` captured; each `visionConflict` opens
//               a P3 `plan-check` finding for the checkpoint (R17, src/holistic/findings.ts), never a redirect.
//   build       the implementer round (rounds.ts) under its entry reservation, held from reserve to
//               teardown; the D4 escalation is decided before the seat (G1); prompt: fast lanes only, the
//               worktree, the evidence dir, the pinned scope, the approving plan-check's notes. A resumed
//               session that never persisted re-runs once, fresh (`callRound`). A resolve round, or the
//               continue of one, must leave the merge-in committed.
//   quiesce     the build invocation's workload is empty (invoke already guarantees it; asserted).
//   evidence    `evidence.snapshot` of the build's stdout, stderr and evidence dir, and the fast lanes'
//               declared outputs in the worktree; then the implementer's decisions.json is appended to
//               the spec's decisions (spec.patch by the executor).
//   salvage     `salvage.commit` under the pinned scope; a plan contract, the architecture doc or its
//               digest in the unit's merge-base diff is a risk trigger; a merge left in progress parks. A
//               failed salvage cleans the build's reservation, and the instances that cleanup failed join the
//               park's targets (G6).
//   teardown    cleanup of the build's reservation.
//   lanes       lanes.ts in a detached checkout of the salvage SHA; the lane ledger for the gate. M4a rev 3: a plan known
//               defect the unit matches (by lane before any lane runs, by a red lane's output after) is `known-defect`,
//               uncharged, to prepare (F4, `knownDefectHit`); in a corpus arc a green certified series then runs the
//               executable checks: witness presence (witnesscheck.ts, D1) and mutation smoke (smoke.ts, D2). The
//               verification checkout is kept only when the gate is next.
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
import { freshJudgmentSession } from '../backends/argv.ts';
import type { HoldCause, IntentOf, OpKind, OutcomeStage, StageOutcomeDetail, StageOutcomeKind } from '../core/events.ts';
import { crashPoint } from '../core/crash.ts';
import { captureUnderFence, holdFence } from '../core/fence.ts';
import { durableMkdir } from '../core/fsx.ts';
import {
  type ImplementerSessionId, type InvocationId, witnessItemIdOf, witnessItemSeq, type JudgmentSessionId, type LaneId, type ResourceInstance, type RoutingRev, type Sha, type Sha256Hex, type SpecRev, type UnitId, invocationId,
} from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { type ApprovalFingerprint, type SpecM1, type SpecPatchOp, type NeedsUserContent, STDERR_FILE, STDOUT_FILE, specWitnesses } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import {
  type AbsPath, type RefName, type RepoPath, type RepoPattern, absPath, branchRef, gitDate, isoTimeOf, repoPath, repoPattern,
} from '../core/values.ts';
import { FILES_DIR, capturedEvidence, pathPattern } from '../git/evidence.ts';
import { GitError, type Identity, git, gitRun, refTarget, revParse } from '../git/git.ts';
import { mergeHead, resolvedHead } from '../git/mergein.ts';
import { SalvageStateError, SalvageUnmergedError, planSalvage, type SalvageRules } from '../git/salvage.ts';
import { unitDiffPaths } from '../git/transient.ts';
import {
  type CorpusInForce, type LoadedSpec, CORPUS_FILE_INPUT, OBLIGATIONS_INPUT, PLAN_INPUT, RULING_INPUT, RULINGS_INPUT, SPEC_INPUT, VISION_INPUT, inputPath, keptInput,
  keptPayload, parseUnitSpec, requirePlanInForce, revisionInForce, specBytesOf, specShaInForce,
} from '../input/inforce.ts';
import { type KnownDefect, type PlanUnit, advancesOf, knownDefectsOf, parsePlan, planCheckShapeOf, targetDocumentPaths, targetDocuments } from '../input/plan.ts';
import { type CorpusView, materialiseCorpus } from '../corpus/materialise.ts';
import { openFinding, visionConflictDraft } from '../holistic/findings.ts';
import { specCensusMismatches } from '../holistic/rederive.ts';
import { type Obligations, type RulingSidecar, type Vision, parseObligations, parseRulingSidecar, parseVision } from '../holistic/types.ts';
import { promptFor } from '../prompts/index.ts';
import type {
  ArchitectureInput, BuildAssess, Checkout, CorpusInput, DocText, FastLane, GateTargetInput, PlanCheckAcceptance, PlanCheckCheckouts, PlanCheckPriorRound, ReferenceIndex,
  RulingText,
  TargetInput, VisionInput,
} from '../prompts/inputs.ts';
import { visionInputOf } from '../prompts/inputs.ts';
import {
  DECISIONS_FILE, type DecisionsFile, PLAN_ASSESSMENT_SCHEMA, PLAN_CHECK_ACCEPTANCE_SCHEMA, type PlanAssessmentOutput, type PlanCheckOutput, type Premise, buildOutputFor,
  buildSchemaFor, validateDecisionsFile, validatePlanAssessment, validatePlanCheckAcceptanceOutput, validatePlanCheckOutput,
} from '../prompts/schemas.ts';
import { ASSESSED_DIRECTIVE } from '../prompts/directives.ts';
import { type ParkFacts, NO_PARK_FACTS, repeatNeedsUser, stageOutcomeFact } from '../park/table.ts';
import { resolveArgv0 } from '../preflight/argv0.ts';
import type { JudgmentRole } from '../routing/types.ts';
import { buildCpu, requestOf } from '../resources/pool.ts';
import { probe } from '../resources/probe.ts';
import { type Reservation, type StageHolder, cleanup, fastLanes, heldReservation, holderUnits, run } from '../resources/reserve.ts';
import { knownDefectActive } from '../schedule/ready.ts';
import { CPU_COST, type ResourceRequest } from '../schedule/types.ts';
import { renderSpec } from '../spec/render.ts';
import { bytesSha256 } from '../spec/spec.ts';
import { type Ruling, parseRulings } from '../spec/rulings.ts';
import { SpecPatchOpError, SpecPatchStaleError, applySpecPatch, specPatchOp } from '../spec/patch.ts';
import { runnerFiles } from '../runner/files.ts';
import {
  type BackendCallOutcome, type BackendCallSpec, type BackendVerdict, type Cancelled, type ImplementerDispatch, type Pinned, type StageContext, type StageParent,
  backendOf, callBackend, cancelledNow, dispatchOf, enter, evidenceRoot, implementerDispatch, isCancelled, judgmentDeadlineMs, judgmentDispatch, nonEmpty, pinDispatch,
  raiseRisk, riskAbove, runOp, runPrepared, sameSession, steerDispatch, unitBranch, unitWorktree, verdictOf, verificationWorktree, workDir,
} from './dispatch.ts';
import { invocationDir, quiescent } from './invoke.ts';
import {
  type LaneRecord, type LaneRuntime, type VerificationTree, dirtyPaths, laneOrder, laneRuntime, presentCheckouts, removeCheckout, removeVerificationTree, runLaneSeries,
  seriesEntry, specSeriesRoot,
} from './lanes.ts';
import { mutationSmoke, survivingObligations } from './smoke.ts';
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
  inputs: Readonly<{ tip: Sha; head: Sha | null; specRev: SpecRev; specSha256: Sha256Hex; routingRev: RoutingRev; fingerprint?: ApprovalFingerprint }>,
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

/** A unit's backend spawns of one judgment role, in log order. */
export const judgmentSpawns = (ctx: StageContext, unit: UnitId, role: JudgmentRole): readonly IntentOf<'proc.spawn'>[] =>
  ctx.journal.view.opsOf('proc.spawn').filter((i) => {
    const s = i.expect.subject;
    return s.purpose === 'backend' && s.role === role && s.unit === unit;
  });

/** The validated output of a judgment spawn, or null when it has none (a fault, a refusal, a malformed answer). */
export function judgmentOutput<T>(ctx: StageContext, intent: IntentOf<'proc.spawn'>, validate: (value: unknown) => T): T | null {
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

/** The acceptance shape's inputs (R59): the spec's next free witness item id and the arc lanes an item may name. */
function acceptanceOf(ctx: StageContext, spec: SpecM1): PlanCheckAcceptance {
  const seqs = specWitnesses(spec).map((w) => witnessItemSeq(w.id));
  const lanes = holisticInForce(ctx).obligations?.lanes.map((l) => l.id) ?? [];
  return { nextWitnessId: witnessItemIdOf(Math.max(0, ...seqs) + 1), arcLanes: [...lanes].sort() };
}

/** The schema file an acceptance-shape plan-check's launch names. */
const acceptanceSchemaPath = (runDir: AbsPath): AbsPath =>
  inputPath(runDir, bytesSha256(Buffer.from(`${canonicalJson(PLAN_CHECK_ACCEPTANCE_SCHEMA)}\n`, 'utf8')), 'schema.json');

/** Whether plan-check invocation `inv` asked the acceptance shape (its launch names that schema). */
function isAcceptanceCall(ctx: StageContext, inv: InvocationId): boolean {
  const launch = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('launch.json');
  if (launch === null) throw new Error(`${inv}: a plan-check invocation without its launch.json`);
  return launch.terminal.type === 'backend' && launch.terminal.schemaPath === acceptanceSchemaPath(ctx.runDir);
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
      direction: ctx.plan().direction, scope: pinned.scope, risk: pinned.riskFloor, checkouts,
      lanePrograms: laneOrder(now.spec).map((l) => ({ lane: l.id, argv0: l.argv[0]!, resolved: resolveArgv0(l, ctx.hostEnv) })),
      priorRound: planCheckPriorRound(ctx, unit.id, checkouts),
      // R17: the vision in force, read-only context (the module marks it non-directive).
      vision: visionInput(ctx),
      // E (R59): an efficient builder's check under `by-builder` maps acceptance clauses to witness items.
      acceptance: shape === 'acceptance' ? acceptanceOf(ctx, now.spec) : null,
      priorInvalid: planCheckPriorInvalid(ctx, unit.id, now.spec),
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
  const called = await callBackend(ctx, {
    unit: unit.id, parent, request: { kind: 'judgment', dispatch: seat, session, evidenceDirs: dirs },
    system: prompt.system, rendered, schema: shape === 'acceptance' ? PLAN_CHECK_ACCEPTANCE_SCHEMA : prompt.schema, cwd: checkouts.tip.path,
    deadlineAt: inMs(judgmentDeadlineMs(pinned)),
  });
  return planCheckRead(ctx, unit, parent, called, session.id);
}

/** Cites a patch adds that name no plan contract or no ledger ruling: an unusable judgment. */
function unknownCites(ctx: StageContext, patch: PlanCheckOutput['patch']): boolean {
  const rulings = ledger(ctx).map((r) => r.id);
  return (patch ?? []).some((op) => op.op === 'cite'
    && (op.contracts.some((c) => !ctx.plan().contracts.includes(c)) || op.rulings.some((r) => !rulings.includes(r))));
}

/**
 * Run 10 (C): a redirect's patch keeps the specs consistent with the census, by the one predicate the Phase-0 rows and
 * every revision's classifier run (src/holistic/rederive.ts `specCensusMismatches`). The mismatches the patched spec
 * `after` adds over `before`, as the retry reads them; null when it adds none (or the arc has no census).
 */
function censusRefusal(ctx: StageContext, before: SpecM1, after: SpecM1): string | null {
  const obligations = holisticInForce(ctx).obligations;
  const census = obligations?.census;
  if (obligations === null || census === undefined) return null;
  const had = new Set(specCensusMismatches([before], obligations, census).map((p) => canonicalJson(p)));
  const added = specCensusMismatches([after], obligations, census).filter((p) => !had.has(canonicalJson(p)));
  if (added.length === 0) return null;
  return added.map((p) => (p.item.startsWith('I-')
    ? `unit ${p.unit} declares ${p.item}, on ${p.rule}, whose census state is ${p.state}`
    : `unit ${p.unit}'s ${p.item.startsWith('W-') ? 'witness item' : 'acceptance clause'} ${p.item} names ${p.rule}, which the census puts out of slice: cite only in-slice rules in an acceptance clause or witness item, or leave ${p.rule} as a note (a facts item, or notes)`)).join('; ');
}

/**
 * The census refusal of the unit's latest plan-check answer (`censusRefusal`), for the retry to correct: its redirect
 * patch re-applied to the spec it judged, still in force (a refused patch leaves the rev); null otherwise.
 */
function planCheckPriorInvalid(ctx: StageContext, unit: UnitId, spec: SpecM1): string | null {
  const spawn = judgmentSpawns(ctx, unit, 'planCheck').at(-1);
  if (spawn === undefined || spawn.parent.type !== 'stage') return null;
  const out = judgmentOutput(ctx, spawn, validatePlanCheckOutput);
  if (out === null || out.patch === null) return null;
  if (ctx.journal.view.judgmentInputs(unit, 'plan-check', spawn.parent.attempt)?.specRev !== spec.rev) return null;
  const by = { role: 'planCheck', routingRev: dispatchOf(ctx.journal.view, unit).routingRev, inv: invocationId(spawn.op, spawn.ordinal) } as const;
  let after: SpecM1;
  try {
    after = applySpecPatch(spec, { expectRev: spec.rev, by, ops: out.patch });
  } catch (error) {
    if (error instanceof SpecPatchOpError) return null;
    throw error;
  }
  return censusRefusal(ctx, spec, after);
}

/**
 * Records a plan-check attempt from its call: the live one, or one recovery closed after a crash (consumed
 * by the driver, never asked again). Re-entrant: a spec patch or risk raise this attempt already made is
 * found in the log and not made twice, and the judgment is read against the spec revision it saw.
 */
export async function planCheckRead(
  ctx: StageContext, unit: PlanUnit, parent: StageParent & Readonly<{ stage: 'plan-check' }>, called: BackendCallOutcome, session: JudgmentSessionId,
): Promise<PlanCheckDone> {
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

  // E (R59): the acceptance shape's answer may only add or replace witness items and facts, and cite; a witness item
  // names an arc lane.
  const acceptance = called.kind === 'result' && isAcceptanceCall(ctx, called.inv);
  let out: PlanCheckOutput;
  try {
    out = acceptance ? validatePlanCheckAcceptanceOutput(v.value) : validatePlanCheckOutput(v.value);
  } catch (error) {
    if (error instanceof SchemaError) return done(record(ctx, parent, 'malformed'));
    throw error;
  }
  if (acceptance) {
    const lanes = new Set(acceptanceOf(ctx, spec).arcLanes);
    if ((out.patch ?? []).some((op) => (op.op === 'add' || op.op === 'replace') && op.section === 'witnesses' && !lanes.has(op.item.lane))) {
      return done(record(ctx, parent, 'malformed'));
    }
  }
  // R17: each vision conflict opens a P3 finding for the checkpoint (a re-read merges into it), whatever the decision; it
  // is never a redirect by itself. A conflict citing no active clause of the vision in force (or with no vision) is an
  // unusable judgment.
  if (out.visionConflict.length > 0) {
    const active = new Set((holisticInForce(ctx).vision?.clauses ?? []).filter((c) => c.state === 'active').map((c) => c.id));
    if (out.visionConflict.some((v) => v.clauses.some((c) => !active.has(c)))) return done(record(ctx, parent, 'malformed'));
    for (const v of out.visionConflict) openFinding(ctx.journal, visionConflictDraft({ unit: unit.id, attempt: parent.attempt, clauses: v.clauses, note: v.note }));
  }
  // R2: the judgment may raise the floor, never lower it, and a redirect may not widen the envelope.
  if (riskAbove(pinned.riskFloor, out.risk)) return done(record(ctx, parent, 'risk-lowered'));
  if (widenedResources(unit, out.patch).length > 0) return done(record(ctx, parent, 'scope-widened'));
  if (unknownCites(ctx, out.patch)) return done(record(ctx, parent, 'malformed'));
  const patch = out.patch === null ? null : { expectRev: specRev, by: { role: 'planCheck', routingRev: pinned.routingRev, inv: called.inv }, ops: out.patch } as const;
  if (patch !== null && applied === null) {
    let after: SpecM1;
    try {
      after = applySpecPatch(spec, patch);
    } catch (error) {
      // A patch against ids that do not exist, or reusing one, is an unusable judgment.
      if (error instanceof SpecPatchOpError || error instanceof SpecPatchStaleError) return done(record(ctx, parent, 'malformed'));
      throw error;
    }
    // Run 10 (C): a patch citing an out-of-slice rule is not applied; the retry is told why (`planCheckPriorInvalid`).
    if (censusRefusal(ctx, spec, after) !== null) return done(record(ctx, parent, 'malformed'));
  }
  if (riskAbove(out.risk, pinned.riskFloor)) raiseRisk(ctx, pinned, out.risk, { rev: specRev, sha256: seenSha256 });
  // A redirect beyond its bound escalates instead; only a redirect the table takes patches the spec.
  const redirects = outcomeFact(ctx.journal.view.unit(unit.id), { stage: 'plan-check', kind: 'redirect' }, parent.attempt).class === 'redirect';
  if (patch !== null && applied === null && redirects) {
    await machinePatch(ctx, unit.id, parent, { path, oldSha256: sha256, patch });
    if (acceptance) crashPoint('plancheck.after-witness-patch', unit.id);
  }
  return done(record(ctx, parent, out.decision));
}

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
    fastLanes: activeFastLanes(spec), evidenceDir: work, worktree: round.worktree, scope: pinned.scope, fixRound, witnessChecks, assess,
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
 * The implementer's decisions.json, as captured by the snapshot, appended to the spec's decisions section
 * (lead ruling, step 12): one `spec.patch` by the executor, so the gate grades against every decision taken
 * and the new revision is part of the approval fingerprint. A new id is added, a decision restated with new
 * text replaces the active one, a decision restated verbatim is already there. A file that does not
 * validate, or an entry naming an item that is not an active decision, is not appended: it stays in the
 * build's evidence dir, which the gate reads. Nor is anything appended while the architect's revision of the
 * spec is pending (`UnitState.pendingRevision`): the unit re-opens on that revision at its next boundary that
 * allows it, and its next build writes its decisions again.
 */
async function appendDecisions(ctx: StageContext, unit: PlanUnit, run: BuildRun, file: AbsPath, parent: StageParent): Promise<void> {
  if (!existsSync(file)) return;
  let decisions: DecisionsFile;
  try {
    decisions = validateDecisionsFile(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof SchemaError) return;
    throw error;
  }
  if (ctx.journal.view.unit(unit.id).pendingRevision !== null) return;
  const { path, spec, sha256 } = loadUnitSpec(ctx, unit);
  const ops = decisions.decisions.flatMap((d): SpecPatchOp[] => {
    const other = [...spec.lanes, ...spec.acceptance, ...spec.facts].some((i) => i.id === d.id);
    const decided = spec.decisions.find((i) => i.id === d.id);
    if (other || (decided !== undefined && decided.state !== 'active')) return [];
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
    scope: pinned.scope,
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
type LanesVerdict = Readonly<{ kind: StageOutcomeKind<'lanes'>; detail?: StageOutcomeDetail; needsUser?: NeedsUserContent; failed?: readonly ResourceInstance[] }>;

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
  // F4: a red lane whose output names a known defect is that defect (uncharged), not a red series.
  if (verdict.kind === 'red') {
    const hit = knownDefectHit(ctx, unit, spec, series.ledger);
    if (hit !== null) verdict = { kind: 'known-defect', detail: { kind: 'known-defect', id: hit.id, match: hit.match } };
  }
  // D1, D2 (corpus arcs): only after a green certified spec series.
  if (verdict.kind === 'green' && checksApply(ctx)) verdict = await executableChecks(ctx, unit, parent, salvaged, rt);
  const kind = verdict.kind;
  // The gate reads the verification checkout: kept only when the gate is next (green, or survivors past the smoke bound).
  const next = transition(ctx.journal.view.unit(unit.id), { stage: 'lanes', kind });
  const keep = next.kind === 'stage' && next.stage === 'gate' ? series.tree : null;
  if (series.tree !== null && keep === null) await removeVerificationTree(ctx, series.tree, parent);
  const fix = kind === 'red' || (kind === 'not-certified' && series.dirty.length > 0) ? laneFixRound(series.ledger, series.dirty, salvaged) : null;
  const facts = failedFacts(verdict.failed ?? []);
  return { ...record(ctx, parent, kind, verdict.needsUser ?? null, facts, undefined, verdict.detail), at: salvaged, ledger: series.ledger, verification: keep, fix };
}
