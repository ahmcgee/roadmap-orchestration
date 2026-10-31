import { captureUnderFence } from '../core/fence.ts';
import { raiseNeedsUser, raisedWithReason } from '../needsuser.ts';
import { methodContext, runReview, diagnosisDue, diagnosed } from './surface.ts';
import { systemsMapInForce } from '../input/systems.ts';
import { protectedPathsInForce } from '../input/protected.ts';
// Unit stages from optional pre-build annotation through certification. All effects are journaled;
// recovery consumes completed invocations against captured inputs. A marker review annotates the
// builder and creates standing gate items; it cannot redirect, split, scaffold or amend the plan.
// Build resources remain held through evidence, salvage and teardown. Certification runs on a clean
// salvage checkout. The root owns plan changes through CAS apply; builders receive notes and proof evidence.
import { systemNotes } from './systemnotes.ts';
import { memoryMessage, salvageSummary } from './memory.ts';
import { existsSync,readFileSync } from 'node:fs';
import { basename,dirname,isAbsolute,join,normalize,relative } from 'node:path';
import { walkMcpConfig } from '../backends/mcp.ts';
import { evaluateRevision } from '../commands/apply.ts';
import type { DesignRecord,Verification } from '../core/design.ts';
import {
BACKEND_PARK_CLASSES,type DiffShown,type GateLargeDiff,type HoldCause,type IntentOf,type JudgmentStage,type OpKind,type OutcomeStage,type StageOutcomeDetail,type StageOutcomeKind } from '../core/events.ts';
import { holdFence } from '../core/fence.ts';
import { durableMkdir } from '../core/fsx.ts';
import {
type InvocationId,type JudgmentSessionId,type LaneId,
type ObligationId,
type ResourceInstance,type ResourceName,type RoutingRev,
type RuleId,
type Sha,type Sha256Hex,type SpecRev,type UnitId,invocationId,
} from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { censusOf } from '../core/projections.ts';
import { type ApprovalFingerprint, type LaneDef, type NeedsUserContent, STDERR_FILE, STDOUT_FILE, type SpecM1, type SpecPatchOp, isRed, specForces, specObligations, specRepairs } from '../core/records.ts';
import type { GateReview } from '../core/review.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type RefName, type RepoPath, type RepoPattern, absPath, branchRef, gitDate, isoTimeOf, repoPath, repoPattern } from '../core/values.ts';
import { type CorpusView,materialiseCorpus } from '../corpus/materialise.ts';
import { FILES_DIR,capturedEvidence } from '../git/evidence.ts';
import { GitError,type Identity,git,gitRun,refTarget,revParse } from '../git/git.ts';
import { mergeHead,resolvedHead } from '../git/mergein.ts';
import { type SalvageRules,SalvageStateError,SalvageUnmergedError,checkRejected,planSalvage } from '../git/salvage.ts';
import { diffBase,transientCheck,unitDiffPaths,unitTransientRules } from '../git/transient.ts';
import { openFinding,visionConflictDraft } from '../holistic/findings.ts';
import { selectObligations,unitRules } from '../holistic/impact.ts';
import { ruleMentions } from '../holistic/rederive.ts';
import { type ImpactInput,type ObligationDef,type Obligations,type Vision,parseObligations,parseVision } from '../holistic/types.ts';
import { witnessLaneReasons } from '../input/classify.ts';
import { regenerateLanes,unitRegenerateLanes } from '../input/derived.ts';

import {
CORPUS_FILE_INPUT,
type CorpusInForce,type InputFiles,type LoadedSpec,
OBLIGATIONS_INPUT,PLAN_INPUT,
RULINGS_INPUT,SPEC_INPUT,VISION_INPUT,inForceFiles,
inputPath,keptInput,keptPayload,parseUnitSpec,requirePlanInForce,revisionInForce,specBytesOf,specShaInForce
} from '../input/inforce.ts';
import {
type KnownDefect,type PlanUnit,boundsOf,advancesOf,designUnitOf,knownDefectsOf,milestonesOf,parsePlan,targetDocumentPaths,targetDocuments,
} from '../input/plan.ts';
import { orderingReasons } from '../park/ordering.ts';
import { NO_PARK_FACTS,type ParkFacts,repeatNeedsUser,stageOutcomeFact } from '../park/table.ts';
import { referenceFiles } from '../phase0/rows.ts';
import { promptFor,renderPrompt } from '../prompts/index.ts';
import type {
ArchitectureInput,BuildBrowser,
BuildLane,
Checkout,CorpusInput,DocText,EscalationInput,
GateTargetInput,MilestonesInput,
ReferenceIndex,RulingText,TargetInput,UnitMilestone,
UnitTargetInput,
VisionInput } from '../prompts/inputs.ts';
import { type Handover,visionInputOf } from '../prompts/inputs.ts';
import {
BUILD_SCHEMA,
DECISIONS_FILE,type DecisionsFile,type Premise,buildOutput,
validateDecisionsFile,
} from '../prompts/schemas.ts';
import { evidenceSnapshotOp,salvageCommitOp,worktreeCreateOp,worktreeRemoveOp } from '../recover/ops.ts';
import { buildCpuKey,cpuCost } from '../resources/calibrate.ts';
import { environmentUnavailable } from '../resources/environments.ts';
import { buildCpu,requestOf } from '../resources/pool.ts';
import { probe } from '../resources/probe.ts';
import { type Reservation,type StageHolder,buildLanes,cleanup,heldReservation,holderUnits,run } from '../resources/reserve.ts';
import type { JudgmentRole,JudgmentSeat,Triple } from '../routing/types.ts';
import { runnerFiles } from '../runner/files.ts';
import { knownDefectActive } from '../schedule/ready.ts';
import { CPU_COST,type ResourceRequest } from '../schedule/types.ts';
import { SpecPatchOpError,SpecPatchStaleError,applySpecPatch,specPatchOp } from '../spec/patch.ts';
import { renderSpec } from '../spec/render.ts';
import { type Ruling,parseRulings } from '../spec/rulings.ts';
import { specBytes } from '../spec/spec.ts';
import { verificationReasons,verifyRunsOf } from './deflake.ts';
import { departures } from './design.ts';
import { type BackendCallOutcome, type BackendCallSpec, type BackendVerdict, type Cancelled, type ImplementerDispatch, type Pinned, type StageContext, type StageParent, backendOf, cancelledNow, dispatchOf, enter, evidenceRoot, fastSuiteWorktree, implementerDispatch, isCancelled, nonEmpty, pinDispatch, raiseRisk, riskAbove, runOp, runPrepared, steerDispatch, unitBranch, unitWorktree, verdictOf, verificationWorktree, workDir } from './dispatch.ts';

import { handoverOf,lineageOf,unmetClauses } from './handover.ts';
import { invocationDir,quiescent } from './invoke.ts';
import {
LANE_DEADLINE_MS,
type LaneRecord,type LaneRuntime,
type Reusable,
type Series,type VerificationTree,builderSuiteLanes,dirtyPaths,dirtySnapshot,laneOrder,laneRuntime,
laneSummaryIn,
mapInForce,presentCheckouts,removeCheckout,
removeVerificationTree,runLaneSeries,seriesEntry,
seriesOrder,
specSeriesRoot,stageSuiteLanes
} from './lanes.ts';

import {
type DecidedRound,type PreparedRound,type RoundCall,type RoundInput,callRound,decidedRound,laneFixRound,prepareRound,
resolveContinuation,
steerBrief,
} from './rounds.ts';
import { mutationSmoke,survivingObligations } from './smoke.ts';

import { pressureCause,seriesRuling } from './starved.ts';
import { type BuildRound,type Next,type StageOutcome,outcomeFact,transition } from './transitions.ts';
import { checksApply,publishWitnessLaneFiles,requiredAt,witnessPresence } from './witnesscheck.ts';
// dev.17 (propagation)
import { type PlanRev,parseInvocationId } from '../core/ids.ts';
import type { SpecPatch } from '../core/records.ts';
import { pinsOf, staleAnswerReasons, unitStaleLinks } from '../holistic/staleset.ts';
import { obligationsAtRev } from '../input/inforce.ts';

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
export const failedFacts = (failed: readonly ResourceInstance[]): ParkFacts => ({ backend: null, failed, environment: null });
/** dev.17: an `env-unavailable` park's facts: the environment that did not come up. */
export const environmentFacts = (environment: ResourceName): ParkFacts => ({ backend: null, failed: [], environment });

// ---------------------------------------------------------------------------------------------------
// Entry reservations (A1, F6)

/** The holder a stage attempt reserves under. */
export const stageHolder = (parent: StageParent): StageHolder => ({ type: 'stage', unit: parent.unit, stage: parent.stage, attempt: parent.attempt });

/** A judgment's entry reservation: `@cpu`×1. */
export const judgmentEntry = (): ResourceRequest => ({ named: [], pools: [], cpu: CPU_COST.judgment, publication: false });

/** A build's entry reservation: only calibrated `@cpu`; named resources belong to executor lanes. */
export const buildEntry = (ctx: StageContext, unit: PlanUnit): ResourceRequest | null => {
  const tier = ctx.journal.view.unit(unit.id).buildTier;
  if (tier === null) throw new Error(`unit ${unit.id} has no build tier at admission`);
  const routing = ctx.routing(unit.id);
  const basis = cpuCost(ctx, buildCpuKey({ role: 'build', class: routing.classes.build[tier], routingRev: routing.rev }), CPU_COST.build, unit.cpu);
  return nonEmpty(requestOf(ctx.plan(), [], buildCpu(unit, basis), basis));
};

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
  ctx: StageContext, parent: StageParent & Readonly<{ stage: 'pre-build' | 'gate' }>,
  inputs: Readonly<{
    tip: Sha; head: Sha | null; specRev: SpecRev; specSha256: Sha256Hex; routingRev: RoutingRev; fingerprint?: ApprovalFingerprint; diffShown?: DiffShown; largeDiff?: GateLargeDiff | null;
    review?: GateReview; standingReview?: readonly import('../core/events.ts').ReviewItem[]; designEstimate?: number | null;
  }>,
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
 * plan contract and active ledger ruling as one index line; withdrawn rulings contribute ids only.
 * Startup refuses a cite the plan or ledger does not hold (the plan-invalid `unknown-cite` row).
 */
export function library(ctx: StageContext, spec: SpecM1, tip: Sha): Library {
  return {
    contracts: spec.cites.contracts.map((c) => docAt(ctx, tip, c)), rulings: [],
    index: {contracts: ctx.plan().contracts.filter((c) => !spec.cites.contracts.includes(c)).map((path) => ({path, heading: firstHeading(docAt(ctx, tip, path).text)})), rulings: [], withdrawn: [], ledger: ledgerPath(ctx)},
  };
}

/**
 * dev.13: the milestones `unit` takes part in under the plan in force (a member of their `units`, or their design unit), in
 * plan order, with their design references at `tip` (`MilestonesInput`); null when it is in none. What its pre-build,
 * build and gate read.
 */
export function unitMilestones(ctx: Pick<StageContext, 'plan' | 'repo'>, unit: UnitId, tip: Sha): MilestonesInput | null {
  const of = milestonesOf(ctx.plan()).flatMap((m): UnitMilestone[] => {
    if (designUnitOf(m) === unit) return [{ as: 'design', id: m.id, text: m.text, dirs: m.references, journeys: m.journeys }];
    return m.units.includes(unit) ? [{ as: 'member', id: m.id, text: m.text, dirs: m.references }] : [];
  });
  if (of.length === 0) return null;
  const files = referenceFiles(ctx.repo, tip, of.flatMap((m) => m.dirs));
  return { of, references: files.flatMap((f) => (f.text === null ? [] : [{ path: f.path, text: f.text }])), binary: files.flatMap((f) => (f.text === null ? [f.path] : [])) };
}

/**
 * dev.13: the browser drive of a Claude build of `unit` in a milestone (a member or its design unit) with a `browser` journey:
 * the `walkthrough.mcp` servers (the repo config the arc started under; bootstrap refuses a `browser` journey without
 * them) and the `--mcp-config` text with `{evidence}` the build's evidence dir `evidenceDir`. Null on a Codex seat, or
 * when no such milestone has the unit.
 */
export function buildBrowser(
  ctx: Pick<StageContext, 'plan' | 'routingBase'>, unit: UnitId, backend: Triple['backend'], evidenceDir: AbsPath,
): Readonly<{ input: BuildBrowser; mcpConfig: string }> | null {
  if (backend !== 'claude') return null;
  const browser = milestonesOf(ctx.plan()).filter((m) => (m.units.includes(unit) || designUnitOf(m) === unit) && m.journeys.some((j) => j.via === 'browser'));
  if (browser.length === 0) return null;
  const servers = ctx.routingBase.config?.walkthrough?.mcp;
  if (servers === undefined) throw new Error(`${unit}: milestone ${browser[0]!.id} has a browser journey, but the repo config has no walkthrough.mcp (bootstrap refuses this: walk-tools-missing)`);
  return {
    input: { servers: Object.keys(servers), bringUps: browser.map((m) => ({ milestone: m.id, bringUp: m.bringUp })) },
    mcpConfig: walkMcpConfig(servers, evidenceDir),
  };
}

/**
 * The full target an arc judgment embeds at `tip` (the lenses, the checkpoint): an `architecture-doc` arc's digest when
 * the plan names one, else the whole doc; a corpus arc's pinned corpus in force (`corpusTarget`), the vision document
 * included. Unit judgments use `unitTarget`.
 */
export function architecture(ctx: StageContext, tip: Sha): TargetInput {
  return documentTarget(ctx, tip) ?? corpusTarget(ctx, 'full');
}

/** A unit's target: selected anchors, universally binding rules and explicit mentions. The gate's view omits vision (M3 R17). */
export function unitTarget(ctx: StageContext, tip: Sha, view: 'without-vision', anchoredBy: readonly ObligationDef[], mentioned: readonly RuleId[]): GateTargetInput;
export function unitTarget(ctx: StageContext, tip: Sha, view: CorpusView, anchoredBy: readonly ObligationDef[], mentioned: readonly RuleId[]): UnitTargetInput;
export function unitTarget(ctx: StageContext, tip: Sha, view: CorpusView, anchoredBy: readonly ObligationDef[], mentioned: readonly RuleId[]): UnitTargetInput {
  const doc = documentTarget(ctx, tip);
  if (doc !== null) return doc;
  const full = corpusTarget(ctx, view);
  const obligations = holisticInForce(ctx).obligations;
  if (obligations === null) throw new Error('a corpus target requires obligations');
  const rules = unitRules(corpusInForce(ctx).pin.value, censusOf(obligations) ?? [], anchoredBy, mentioned);
  return { kind: 'unit-corpus', rules, others: full.rulesIndex.length - rules.length, dir: full.dir, visionDoc: full.visionDoc };
}

/** The directories a judgment reads beside its checkout for `target`: a corpus arc's materialised pin (`--add-dir`). */
export const targetDirs = (target: TargetInput | UnitTargetInput): readonly AbsPath[] => (target.kind === 'corpus' || target.kind === 'unit-corpus' ? [target.dir] : []);

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

/** The unit's dependency closure in the plan in force: every unit it runs `after`, transitively. */
function dependencyClosure(ctx: StageContext, unit: PlanUnit): readonly PlanUnit[] {
  const byId = new Map(ctx.plan().units.map((u) => [u.id, u]));
  const seen = new Set<UnitId>();
  const walk = (u: PlanUnit): void => {
    for (const d of u.after) {
      const dep = byId.get(d);
      if (dep === undefined || seen.has(d)) continue;
      seen.add(d);
      walk(dep);
    }
  };
  walk(unit);
  return [...seen].sort().map((id) => byId.get(id)!);
}

/** The shared impact input for a unit judgment; pre-build has no changed paths yet. */
export function unitImpactInput(ctx: StageContext, unit: PlanUnit, spec: SpecM1, changedPaths: readonly RepoPath[]): ImpactInput {
  const { obligations } = holisticInForce(ctx);
  if (obligations === null) throw new Error('unit impact requires obligations');
  const findings = ctx.journal.view.holistic().findings;
  const repairs = specRepairs(spec).flatMap((r): ObligationId[] => {
    if (r.startsWith('I-')) return [r as ObligationId];
    const o = findings.find((f) => f.id === r)?.obligation ?? null;
    return o === null ? [] : [o];
  });
  return {
    obligations, systemsMap: systemsMapInForce(ctx.journal.view.planApplied()),
    units: [{ unit: unit.id, declared: specObligations(spec), repairs }],
    closure: dependencyClosure(ctx, unit).flatMap((u) => specObligations(loadUnitSpec(ctx, u).spec)),
    changedPaths,
    revised: [],
    latched: new Set(ctx.journal.view.holistic().latched.map((l) => l.obligation)),
  };
}

/** The product documents whose change touches the unit's authority: every plan contract, the architecture doc and its digest. */
export function authorityPaths(ctx: StageContext): ReadonlySet<RepoPath> {
  return new Set<RepoPath>([...ctx.plan().contracts, ...targetDocumentPaths(ctx.plan())]);
}

export const inMs = (ms: number) => isoTimeOf(new Date(Date.now() + ms));

type JudgmentOrBuild = 'pre-build' | 'build' | 'gate';

/**
 * Records a call that did not succeed: interrupted (a hold, with its backend-park cause, G5), refusal, malformed,
 * or a process fault (a retryable park on the call's backend).
 */
export function verdictKind<S extends JudgmentOrBuild>(
  ctx: StageContext, parent: StageParent & Readonly<{ stage: S }>, v: Exclude<BackendVerdict, Readonly<{ kind: 'success' }>>, called: BackendCallOutcome,
): StageDone<S> {
  if (v.kind === 'interrupted') return record(ctx, parent, 'interrupted' as StageOutcomeKind<S>, v.needsUser, NO_PARK_FACTS, v.cause ?? undefined);
  if (v.kind === 'process-fault') return record(ctx, parent, 'process-fault' as StageOutcomeKind<S>, null, { backend: backendOf(called), failed: [], environment: null });
  if (v.kind === 'context-exceeded') {
    const detail = { kind: 'context-exceeded', inv: v.inv, promptBytes: v.promptBytes } as const;
    return record(ctx, parent, 'context-exceeded' as StageOutcomeKind<S>, null, NO_PARK_FACTS, undefined, detail);
  }
  return record(ctx, parent, v.kind as StageOutcomeKind<S>);
}

// ---------------------------------------------------------------------------------------------------
// pre-build

/** `session` is null when no judgment was asked (a routing change parked the unit first). */
export type PreBuildDone = StageDone<'pre-build'> & Readonly<{ session: JudgmentSessionId | null; specRev: SpecRev }>;

/**
 * Removes every checkout of the unit a judgment stage's attempts made that is still present (`parent`'s stage: a pre-build's
 * or, dev.13, a gate's; this attempt's once its call is read, or a leftover of an attempt a crash cut short), each citing a
 * snapshot of whatever it holds beyond its commit (a pre-build is read-only, so normally a manifest of zero files, lead
 * ruling 14c; a gate's holds the experiments it wrote, kept as its evidence). Verification checkouts are the lanes stage's
 * and retire's to remove, never this one's.
 */
export async function removeJudgmentCheckouts(ctx: StageContext, unit: UnitId, parent: StageParent): Promise<void> {
  const present = presentCheckouts(ctx.journal.view, unit).filter((c) => c.parent.type === 'stage' && c.parent.stage === parent.stage);
  for (const created of present) {
    if (created.parent.type !== 'stage') throw new Error(`${created.expect.path}: a ${parent.stage} checkout without a stage parent`);
    const { path } = created.expect;
    const dest = absPath(join(evidenceRoot(ctx.runDir, created.parent), basename(path)));
    const view = ctx.journal.view;
    const snapped = view.opsOf('evidence.snapshot').find((i) => i.expect.dest === dest && view.doneOf(i.op) !== null)
      ?? await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${unit}`, parent, { source: path, ...dirtySnapshot(path), dest });
    await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${unit}:${parent.stage}`, parent, { path, evidence: capturedEvidence(ctx.journal.view, snapped.op) });
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
export const judgmentSpawns = (ctx: JudgmentReader, unit: UnitId, stage: JudgmentStage): readonly IntentOf<'proc.spawn'>[] =>
  ctx.journal.view.spawnsOfUnit(unit, 'verifier').filter((i) => i.parent.type === 'stage' && i.parent.stage === stage);


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
  const below = judgmentSpawns(ctx, unit, stage).filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.tier !== 'escalation').at(-1);
  if (below === undefined) throw new Error(`${unit}: the ${stage} routed up with no spawn below the escalation seat`);
  const out = judgmentOutput(ctx, below, validate);
  return { kind: 'route-up', first: out === null ? null : { decision: out.decision, reasons: out.reasons } };
}

/**
 * dev.17 (flaky ledger): the verification a deflake unit's approving pre-build settled in its design record, as the spec in
 * force holds it (null: none). Its lanes stage runs the key's lane that many times (`verifyRunsOf`).
 */
export function approvedVerification(ctx: StageContext, unit: PlanUnit): Verification | null {
  return loadUnitSpec(ctx, unit).spec.design?.verification ?? null;
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


export async function preBuild(ctx: StageContext, unit: PlanUnit): Promise<PreBuildDone | Cancelled> {
  const { spec, sha256 } = loadUnitSpec(ctx, unit);
  const parent = at(start(ctx, unit.id, 'pre-build'), 'pre-build');
  const pin = pinDispatch(ctx, unit, {rev: spec.rev, sha256});
  if (pin.kind !== 'pinned') throw new Error('dispatch failed to re-pin');
  await captureUnderFence(ctx.journal, () => writeJudgmentInputs(ctx,parent,{tip:integrationTip(ctx),head:null,specRev:spec.rev,specSha256:sha256,routingRev:pin.dispatch.routingRev}));
  const entered = await enterJudgment(ctx, parent);
  if (isCancelled(entered)) return entered;
  await runReview(ctx, unit, parent, 'pre-build');
  await releaseJudgment(ctx, parent);
  return {...record(ctx, parent, cancelledNow(ctx) === null ? 'approve' : 'interrupted'), session: null, specRev: spec.rev};
}

/**
 * An executor's spec patch (a pre-build redirect, the implementer's decisions): a machine revision of the unit's spec,
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
  return ctx.journal.view.opsOfParent(kind, parent);
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

const activeBuildLanes = (spec: SpecM1): readonly BuildLane[] =>
  buildLanes(spec).filter((l): l is SpecM1['lanes'][number] & BuildLane => l.state === 'active' && l.cadence === 'build');

export async function build(ctx: StageContext, unit: PlanUnit, input: RoundInput): Promise<BuildDone | Cancelled> {
  if (ctx.journal.view.unit(unit.id).risk === null) {
    const loaded = loadUnitSpec(ctx, unit);
    pinDispatch(ctx, unit, {rev: loaded.spec.rev, sha256: loaded.sha256});
  }
  // A diagnosis is an annotation, delivered as build memory and a Claude fallback.
  if (diagnosisDue(ctx.journal.view, unit.id) && !diagnosed(ctx.journal.view, unit.id) && unit.review !== 'never') {
    const reviewParent = at(start(ctx, unit.id, 'pre-build'), 'pre-build');
    const entered = await enterJudgment(ctx, reviewParent);
    if (isCancelled(entered)) return entered;
    await runReview(ctx, unit, reviewParent, 'diagnosis');
    await releaseJudgment(ctx, reviewParent);
    const cancelled = cancelledNow(ctx);
    if (cancelled !== null) { record(ctx, reviewParent, 'interrupted'); return cancelled; }
    record(ctx, reviewParent, 'approve');
  }
  const parent = at(start(ctx, unit.id, 'build'), 'build');
  const entered = await enter(ctx, stageHolder(parent), buildEntry(ctx, unit));
  if (isCancelled(entered)) return entered;
  const failed = (d: StageDone<'build'>): BuildDone => ({ ...d, run: null });
  const held = await holdEntry(ctx, parent);
  if (held.kind === 'occupied') return failed(record(ctx, parent, 'occupied', held.needsUser));
  if (held.kind === 'cleanup-failed') return failed(record(ctx, parent, 'cleanup-failed', null, failedFacts(held.failed)));
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
  const round = await prepareRound(ctx, dispatch, input, parent);

  const work = workDir(ctx.runDir, parent);
  durableMkdir(work);
  const prompt = promptFor('build', dispatch.triple.model);
  const tip = integrationTip(ctx);
  const impact = holisticInForce(ctx).obligations === null ? null : unitImpactInput(ctx, unit, spec, []);
  const anchors = impact === null ? [] : selectObligations(impact).map((id) => impact.obligations.obligations.find((o) => o.id === id)!);
  const target = unitTarget(ctx, tip, 'without-vision', anchors, ruleMentions(renderSpec(spec)));

  const lib = library(ctx, spec, tip);
  const milestones = unitMilestones(ctx, unit.id, tip);
  // dev.13: a build in a milestone with a browser journey gets the walkthrough MCP servers, its screenshots in `work`.
  const browser = buildBrowser(ctx, unit.id, dispatch.triple.backend, work);
  // D1 (R56): the lane files of the fast required witness lanes, published before the call, and their commands.
  const witnessChecks = checksApply(ctx) ? publishWitnessLaneFiles(ctx, unit, work, requiredAt(ctx, unit, revParse(round.worktree, 'HEAD'))) : [];
  // Field feedback 2026-10-23 item 1: a call on a fresh session gets the handover (src/pipeline/handover.ts); a resumed one does not.
  const handover = handoverOf(ctx, unit.id, spec, parent);
  const handed = (call: RoundCall): Handover | null => (call.session.mode === 'fresh' ? handover : null);
  const state = ctx.journal.view.unit(unit.id);
  const allowance = Math.max(0, state.bounds.certifications - 1 - state.counters.unchargedLanesReds);
  const render = (call: RoundCall) => renderPrompt(prompt, {
    target, spec: { unit: unit.id, rev: spec.rev, markdown: renderSpec(spec, { buildLanesOnly: true }) }, intent: spec.intent, nonGoals: spec.nonGoals, ...lib,
    systemNotes: systemNotes(ctx.repo, revParse(round.worktree, 'HEAD'), unit.systems, ctx.routingBase.config),
    notes: [`Attempt state: ${ctx.journal.view.judgedAttempts(unit.id).builds} builds, ${ctx.journal.view.judgedAttempts(unit.id).stages} judged stages; diagnosis at 8 builds or 20 stages. Chargeable failures ${ctx.journal.view.unit(unit.id).counters.chargeableFailures}/${boundsOf(ctx.plan(), unit).chargeable}.`, ...ctx.journal.view.spawnsOfUnit(unit.id, 'build').slice(-1).flatMap((i) => judgmentOutput(ctx, i, (v) => buildOutput(v, 'build'))?.notes ?? []), ...ctx.journal.view.buildNotes(unit.id, parent.attempt).map((sha) => steerBrief(ctx.runDir, sha)), ...ctx.journal.view.surfaceFacts().flatMap((f) => f.kind === 'review-completed' && f.unit === unit.id && f.note !== null ? [steerBrief(ctx.runDir, f.note)] : []), ...ctx.journal.view.surfaceFacts().flatMap((f) => f.kind === 'review-completed' && f.unit === unit.id && f.mode === 'pre-build' ? f.items.map((x) => `${x.id}: ${x.text} (${x.evidence.join('; ')})`) : [])],
    method: methodContext(ctx, unit, spec),
    fastLanes: activeBuildLanes(spec), suiteLanes: builderSuiteLanes(ctx.plan().suite.lanes, spec), evidenceDir: work, worktree: round.worktree, systems: unit.systems,
    fixRound: call.fixRound === null ? null : { ...call.fixRound, baseComparison: call.fixRound.baseComparison ?? null, capState: {builds: ctx.journal.view.judgedAttempts(unit.id).builds, judgedStages: ctx.journal.view.judgedAttempts(unit.id).stages, chargeableFailures: state.counters.chargeableFailures, chargeableBound: state.bounds.chargeable, certificationAllowance: allowance}, directives: [...call.fixRound.directives,
      `Certification allowance: ${allowance} uncharged red certifications remaining before the next charge.`] }, witnessChecks, milestones, browser: browser?.input ?? null, handover: handed(call),
  }, dispatch.triple.backend);
  const callFor = (prepared: PreparedRound) => (call: RoundCall): BackendCallSpec => ({
    unit: unit.id, parent,
    request: {
      kind: 'implementer', dispatch, session: call.session, evidenceDirs: [...new Set([...targetDirs(target), work, ...call.evidenceDirs, ...(handed(call)?.evidence ?? []), ledgerDir(ctx)])],
      mcpConfig: browser?.mcpConfig ?? null,
    },
    system: prompt.system, ...render(call), schema: BUILD_SCHEMA, cwd: prepared.worktree, deadlineAt: prepared.deadlineAt,
  });
  const called = await callRound(ctx, round, callFor(round));
  // Field feedback 2026-10-23 item 4: a resolve round that reported final with nothing beyond the merge while clauses are unmet
  // goes back to its builder once (rounds.ts `resolveContinuation`); the continuation's outcome is read the normal way.
  const unmet = decidedRound(input) === 'resolve' && called.kind === 'result' && called.result.outcome.kind === 'success' && mergeOnly(ctx, unit.id)
    ? unmetClauses(ctx, lineageOf(ctx.journal.view, unit.id), spec) : [];
  if (unmet.length === 0 || called.kind !== 'result') return buildRead(ctx, unit, parent, decidedRound(input), called, held.reservation);
  const again = resolveContinuation(ctx, dispatch, round, called, unmet, unit.id);
  return buildRead(ctx, unit, parent, decidedRound(input), await callRound(ctx, again, callFor(again)), held.reservation);
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
      buildOutput(v.value, 'build');
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
  if (v.kind === 'success' && !malformed) {
    const report = buildOutput(v.value, 'build');
    const content = (reason: 'spec-wrong' | 'split-proposal', summary: string): NeedsUserContent => ({blocking: reason === 'spec-wrong', subject: {type: 'unit', unit: unit.id}, reason, summary, recommendation: 'The root reviews the evidence and amends the plan with apply --reason.', options: [], evidence: [called.invDir]});
    if (report.tooBig !== null && raisedWithReason(ctx.journal.view, ctx.runDir, parent, 'split-proposal') === null) raiseNeedsUser(ctx.journal, ctx.runDir, content('split-proposal', `Unit ${unit.id}: ${report.tooBig.estimate}; suggested children: ${report.tooBig.suggestedChildren.join('; ')}`), parent);
    if (report.grounding.specWrong !== null) {
      const cleaned = held === null ? null : await cleanup(ctx, held, parent);
      if (cleaned?.kind === 'cleanup-failed') return failed(record(ctx, parent, 'cleanup-failed', null, failedFacts(cleaned.failed)));
      return failed(record(ctx, parent, 'spec-wrong', content('spec-wrong', report.grounding.specWrong)));
    }
  }
  if (v.kind === 'success' && !malformed && called.kind === 'result') {
    const run: BuildRun = { inv: called.inv, invDir: called.invDir, worktree, branch, workDir: workDir(ctx.runDir, parent), reservation: held };
    return { ...record(ctx, parent, 'success'), run };
  }
  // Nothing downstream runs after a failed build, so its resources are cleaned now (the workload is quiescent).
  const cleaned = held === null ? null : await cleanup(ctx, held, parent);
  if (cleaned?.kind === 'cleanup-failed') return failed(record(ctx, parent, 'cleanup-failed', null, failedFacts(cleaned.failed)));
  // Lost again after its retry, with no effect on the tree.
  if (called.kind === 'lost') return failed(record(ctx, parent, 'lost', null, { backend: backendOf(called), failed: [], environment: null }));
  return failed(v.kind === 'success' ? record(ctx, parent, 'malformed') : verdictKind(ctx, parent, v, called));
}

/** The unit's latest merge-in: the conflicted one a resolve round resolves. */
export function latestMergein(ctx: StageContext, unit: UnitId): IntentOf<'mergein.prepare'> | null {
  return ctx.journal.view.opsOf('mergein.prepare').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit).at(-1) ?? null;
}

/**
 * Field feedback 2026-10-23 item 4: whether a resolve round left the merge-in committed and nothing beyond it: HEAD is the merge
 * of [old, T] itself (`resolvedHead`) and the worktree has no tracked or unignored change.
 */
function mergeOnly(ctx: StageContext, unit: UnitId): boolean {
  const intent = latestMergein(ctx, unit);
  if (intent === null) throw new Error(`a resolve round of ${unit} without a merge-in`);
  const head = resolvedHead(intent);
  if (head === null) return false;
  const parents = git(intent.expect.worktree, ['rev-list', '--parents', '-n', '1', head]).trim().split(' ').slice(1);
  return parents.length === 2 && parents[0] === intent.expect.old && parents[1] === intent.expect.integrationTip && dirtyPaths(intent.expect.worktree).length === 0;
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
    source: ctx.runDir, globs: [`${inv}/stdout`, `${inv}/stderr`, `${inv}/result.json`, `${work}/**`].map((g) => repoPattern(g)), dest: dirs[0]!,
  });
  // Keep declared build outputs, including resource-bearing lanes an adopted dev.31 build could run.
  const globs = unique(spec.lanes.filter((l) => l.state === 'active' && l.cadence === 'build').flatMap((l) => l.evidenceGlobs));
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
  const read = readDecisions(file, spec);
  if (typeof read === 'string') {
    process.stderr.write(`roadmap: ${unit.id} ${parent.stage}#${parent.attempt}: ${file} not appended to the spec: ${read}\n`);
    return;
  }
  if (ctx.journal.view.unit(unit.id).pendingRevision !== null) return;
  // dev.17 (design pass): the tests and docs the build changed that the design record's breaks do not list, appended as the
  // builder's departures beside its own decisions (recorded, never refused).
  const changed = git(run.worktree, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=MD', diffBase(ctx.repo, integrationTip(ctx), revParse(run.worktree, 'HEAD'))])
    .split('\0').filter((p) => p !== '').map((p) => repoPath(p));
  const decisions = { decisions: [...(read?.decisions ?? []), ...departures(mapInForce(ctx.journal.view), spec.design, changed)] };
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
    protectedPaths: protectedPathsInForce(ctx.runDir, ctx.journal.view),
    excluded: unique(spec.lanes.flatMap((l) => l.evidenceGlobs)),
    rejectedRoot: absPath(join(ctx.runDir, 'rejected', unit.id)),
  };
  const request = {
    worktree: run.worktree, branch: run.branch,
    identity: executorIdentity(),
    message: memoryMessage(`roadmap ${ctx.plan().arc}: salvage of unit ${unit.id} (build ${run.inv})`, [salvageSummary(ctx, unit.id, run)]),
  };
  const op = salvageCommitOp(rules);
  // A salvage that ends the build chain here never reaches teardown: the build's resources are cleaned now (a failure
  // leaves its residue durable), and the instances it failed are returned for the outcome's park targets (G6).
  const released = async (): Promise<readonly ResourceInstance[]> => {
    const cleaned = run.reservation === null ? null : await cleanup(ctx, run.reservation, parent);
    return cleaned?.kind === 'cleanup-failed' ? cleaned.failed : [];
  };
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
    // Refused before any intent: the tree is untouched and preserved for the architect, and the unit parks.
    return { ...record(ctx, parent, kind, null, failedFacts(await released())), sha: null };
  }
  const next = prepared === null
    ? revParse(run.worktree, 'HEAD')
    : (await runPrepared(ctx.journal, op, `salvage:${unit.id}`, parent, prepared)).post.new;
  // Field report 2026-10-24: the one transient check (src/git/transient.ts), which the candidate runs, at the salvage SHA
  // too, so a path the builder committed under a protected repository path (salvage reverts only uncommitted ones) is
  // refused before the lanes and the gate spend on it. The chain ends here as at a salvage failure, the build's resources
  // cleaned; the outcome is the candidate's refusal (a chargeable protected-path fix round, a risk trigger), or, when that
  // cleanup failed, a park on its instances.
  if (transientCheck(ctx.repo, unitTransientRules(protectedPathsInForce(ctx.runDir, ctx.journal.view), spec), integrationTip(ctx), next).length > 0) {
    const failed = await released();
    return { ...record(ctx, parent, failed.length > 0 ? 'cleanup-failed' : 'transient-violation', null, failedFacts(failed)), sha: next };
  }
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
    const red = ledger.filter((l) => l.lane === k.match.lane && isRed(l.verdict));
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
  /** dev.17: the environment an `env-unavailable` lane could not bring up (the park's target). */
  environment?: ResourceName;
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
    case 'env-unavailable':
      return { kind: 'env-unavailable', environment: d2.environment };
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
// After a green certified spec series the lanes stage runs the plan's build and unit suite lanes and the lanes the unit
// forces (dev.17, `stageSuiteLanes`, `forcedLanes`: less those identical to a spec lane) at the salvage SHA, in their own detached checkout (`fastSuiteWorktree` `suite`), each under
// its own reservation, as `lane{set: suite}` spawns of the lanes attempt with evidence under `<attempt root>/_suite`. So a
// builder's lint or typecheck red is a fix round of its own build, not a candidate red. A failed fast suite (a red lane,
// or a changed checkout) runs again on the unit's diff base alone (`diffBase(T, salvage)`: what the unit built on), the
// red lane only (or, for a changed checkout, every lane that ran), under `<attempt root>/_base`. Base green: the unit's
// red, a certification fix round with the fast suite's evidence (`red`, or `not-certified` for a changed checkout). Base
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
    case 'env-unavailable':
      return { kind: 'env-unavailable', environment: end.environment };
    case 'blocked':
    case 'interrupted':
      return { kind: end.kind };
  }
}

/**
 * `lanes` at `at` in their own checkout, removed afterwards (citing the series' evidence). `verify`: a deflake unit's
 * verification runs; `carry`: passes a docs-only change carries over.
 */
async function fastSuiteSeries(
  ctx: StageContext, parent: StageParent, lanes: readonly LaneDef[], at: Sha, which: 'suite' | 'base', rt: LaneRuntime,
  verify: ReadonlyMap<LaneId, number> = new Map(), carry: ReadonlyMap<LaneId, Reusable> = new Map(),
): Promise<Series> {
  const { worktreeRoot, arc } = ctx.plan();
  const checkout = { path: fastSuiteWorktree(worktreeRoot, arc, parent.unit, parent.attempt, which), checkout: { type: 'detached', at } } as const;
  const series = await runLaneSeries(ctx, parent, lanes, 'suite', checkout, fastSuiteRoot(ctx.runDir, parent, which), rt, false, new Map(), verify);
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

/**
 * The suite lanes a unit forces at its lanes stage (dev.17): its spec's `forces`, and the batch lane of each finding it
 * repairs that a batch lane's red opened (a repair of a batch P1 proves itself on that lane before it merges).
 */
export function forcedLanes(view: JournalView, spec: SpecM1): ReadonlySet<LaneId> {
  const repairs = new Set<string>(specRepairs(spec));
  const batch = view.holistic().findings.flatMap((f) => (f.lane !== undefined && repairs.has(f.id) ? [f.lane] : []));
  return new Set([...specForces(spec), ...batch]);
}

/** The lanes of a lanes attempt's fast suite at `salvaged`: the regenerate checks the unit's diff calls for, then the stage's suite lanes. */
export function fastSuiteLanes(ctx: StageContext, spec: SpecM1, salvaged: Sha): readonly LaneDef[] {
  // dev.12: the regenerate checks of the derived entries the unit's diff touches go first (src/input/derived.ts).
  const regenerate = unitRegenerateLanes(ctx.plan(), unitDiffPaths(ctx.repo, integrationTip(ctx), salvaged));
  return [...regenerate, ...stageSuiteLanes(ctx.plan().suite.lanes, spec, forcedLanes(ctx.journal.view, spec))];
}

/** Reds in the unit's latest completed lanes attempt, excluding holds and the suite's diagnostic base run. */
export function previousLaneReds(ctx: StageContext, unit: PlanUnit, spec: SpecM1, attempt = ctx.journal.view.completedLanes(unit.id)): Readonly<{ spec: ReadonlySet<LaneId>; suite: ReadonlySet<LaneId> }> {
  if (attempt === null) return { spec: new Set(), suite: new Set() };
  const previous: StageParent = { type: 'stage', unit: unit.id, stage: 'lanes', attempt };
  const path = verificationWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id, previous.attempt);
  const created = ctx.journal.view.opsOf('worktree.create').find((i) => i.expect.path === path);
  // A completed attempt may park before running anything (for example a missing witness lane).
  if (created === undefined) return { spec: new Set(), suite: new Set() };
  if (created.expect.checkout.type !== 'detached') throw new Error(`lanes ${unit.id}#${previous.attempt}: no detached verification checkout`);
  const at = created.expect.checkout.at;
  const reds = (lanes: readonly LaneDef[], set: 'spec' | 'suite', root: AbsPath): ReadonlySet<LaneId> => new Set(lanes.filter((lane) => {
    const record = laneSummaryIn(ctx, previous, lane, set, at, root);
    return record !== null && isRed(record.verdict);
  }).map((lane) => lane.id));
  return { spec: reds(spec.lanes, 'spec', specSeriesRoot(ctx.runDir, previous)),
    suite: reds([...regenerateLanes(ctx.plan()), ...ctx.plan().suite.lanes], 'suite', fastSuiteRoot(ctx.runDir, previous, 'suite')) };
}

/** The fast suite after a green spec series: its verdict, and its series at the salvage SHA (null when it has no lane). */
async function fastSuite(
  ctx: StageContext, unit: PlanUnit, spec: SpecM1, parent: StageParent, salvaged: Sha, rt: LaneRuntime, carry: ReadonlyMap<LaneId, Reusable>, red: ReadonlySet<LaneId>,
): Promise<Readonly<{ verdict: LanesVerdict; series: Series | null }>> {
  const lanes = seriesOrder(fastSuiteLanes(ctx, spec, salvaged), red);
  if (lanes.length === 0) return { verdict: { kind: 'green' }, series: null };
  const series = await fastSuiteSeries(ctx, parent, lanes, salvaged, 'suite', rt, verifyRunsOf(unit, approvedVerification(ctx, unit)));
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
  const red = previousLaneReds(ctx, unit, spec);
  const order = seriesOrder(laneOrder(spec), red.spec);
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
    // dev.17 (proportional review): a build's docs-only claim, verified before any lane runs (src/pipeline/docsonly.ts).

  const entry = seriesEntry(ctx, order);
  const entered = await enter(ctx, stageHolder(parent), entry);
  if (isCancelled(entered)) return entered;
  // A checkout an earlier attempt left (a crash cut its stage short) goes first: this series makes its own.
  for (const created of presentCheckouts(ctx.journal.view, unit.id)) await removeCheckout(ctx, created, parent, laneGlobs(ctx, spec));
  const checkout = { path: verificationWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id, parent.attempt), checkout: { type: 'detached', at: salvaged } } as const;
  const rt = laneRuntime(ctx, unit.id);
  const series = await runLaneSeries(ctx, parent, order, 'spec', checkout, specSeriesRoot(ctx.runDir, parent), rt, entry !== null, new Map(), verifyRunsOf(unit, approvedVerification(ctx, unit)));
  const { end } = series;
  let verdict: LanesVerdict = end.kind === 'green' ? { kind: series.dirty.length > 0 ? 'not-certified' : 'green' }
    : end.kind === 'occupied' ? { kind: 'occupied', needsUser: end.needsUser }
    : end.kind === 'cleanup-failed' ? { kind: 'cleanup-failed', failed: end.failed }
    : end.kind === 'env-unavailable' ? { kind: 'env-unavailable', environment: end.environment }
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
  const suite = verdict.kind === 'green' ? await fastSuite(ctx, unit, spec, parent, salvaged, rt, new Map(), red.suite) : null;
  if (suite !== null) verdict = suite.verdict;
  if (verdict.kind === 'red') {
    const red = [...series.ledger, ...(suite?.series?.ledger ?? [])].filter((l) => isRed(l.verdict));
    if (red.length > 0 && red.every((l) => l.flaky && l.diagnostic?.verdict === 'pass') && series.dirty.length === 0 && (suite?.series?.dirty.length ?? 0) === 0) verdict = { kind: 'flaky' };
  }
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
  const fix = kind === 'red' || kind === 'flaky' || (kind === 'not-certified' && dirty.length > 0) ? laneFixRound(ledger, dirty, salvaged) : null;
  const facts = verdict.environment === undefined ? failedFacts(verdict.failed ?? []) : environmentFacts(verdict.environment);
  return { ...record(ctx, parent, kind, verdict.needsUser ?? null, facts, verdict.cause, verdict.detail), at: salvaged, ledger: series.ledger, verification: keep, fix };
}

export function salvageRejections(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>, unit: UnitId): readonly Readonly<{ paths: readonly RepoPath[]; dir: AbsPath }>[] {
  const view = ctx.journal.view;
  const root = absPath(join(ctx.runDir, 'rejected', unit));
  return view.opsOf('salvage.commit').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && view.doneOf(i.op) !== null).map((i) => {
    const dir = absPath(join(root, i.expect.rejectedManifestSha256));
    const checked = checkRejected(dir, i.expect.rejectedManifestSha256);
    if (checked.kind !== 'complete') throw new Error(`unit ${unit}: the rejected content of salvage ${i.op} at ${dir} is incomplete: ${checked.detail}`);
    return { paths: checked.manifest.entries.filter((e) => e.reason === 'protected-path').map((e) => e.path), dir };
  });
}

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
