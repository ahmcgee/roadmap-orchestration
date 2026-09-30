// The event log (`events.jsonl`) record types, their validators, canonical serialisation and the chain
// hash rule. The journal (append, tail, fold) is step 2 and builds on these. SCHEMAS.md "Event log" is the
// prose twin of this module.
import type { Buffer } from 'node:buffer';
import {
  type ArcId, type CommandId, type DivergenceId, type EdgeId, type EnvId, type FindingId, type InvocationId, type JobId, type LaneId, type LaneRev,
  type NeedsUserId, type ObligationId, type OpId, type OpKey, type PlanRev, type ResourceInstance, type ResourceName, type ResourceUnit,
  type RoutingRev, type RulingId, type Sha, type Sha256Hex, type SpecRev, type UnitId, type VisionClauseId, INTEGRATION_SLOT, arcId,
  commandId, compareResourceUnits, divergenceId, edgeId, envId, findingId, invocationIdOf, jobIdOf, jobIdOfKind, laneId, laneRev, needsUserId,
  obligationId, opIdOf, opKey, parseInvocationId, parseOpId, parseResourceUnit, planRev, resourceInstance, resourceName, resourceUnit, routingRev,
  rulingId, sha, sha256, specRev, unitId, visionClauseId,
} from './ids.ts';
import { canonicalJson, sha256Hex } from './json.ts';
import {
  COMMAND_VERDICTS, LENS_KIND_NAMES, type ApprovalFingerprint, type BackendOutcomeKind, type CommandVerdict, type ContainmentMode,
  type DispatchRecord, type KillReason, type LensKindName, type PauseTarget, type PlanManifest, type ResidueRecord, type ResumeTarget,
  type RevisionManifest, type SpecPatch, type Stage, type TokenUsage, type UsageUnavailableReason, approvalFingerprint, containmentMode,
  dispatchRecord, killReason, optionId, pauseTarget, manifestSpecs, resumeTarget, revisionInputs, specPatch, stage, tokenUsage,
  usageUnavailableReason,
} from './records.ts';
import {
  type AuditTrigger, type BundleOutcome, type CheckpointTrigger, type ContractOp, type DivergenceDraft, type FindingEvidence, type FindingLens,
  type FindingSeverity, type FindingSource, type FindingTo, type MutantRef, type ObligationDisposition, type ObservationKey, type RevisionVector,
  type WitnessPurpose, FINDING_LENSES, FINDING_SEVERITIES, OBLIGATION_DISPOSITIONS, WITNESS_PURPOSES, auditTrigger, checkpointTrigger, contractOp,
  divergenceDraft, divergenceDraftFields, findingEvidence, findingSource, findingTo, mutantRef, observationKey, revisionVector,
} from '../holistic/types.ts';
import {
  type Read, Fields, SchemaError, arrayOf, bool, literal, nat, nullable, object, oneOf, positive, sortedBy, str, tagged, text,
  version,
} from './validate.ts';
import {
  type AbsPath, type GitDate, type IsoTime, type RefName, type RepoPath, type RepoPattern, absPath, gitDate, isoTime,
  refName, repoPath, repoPattern,
} from './values.ts';
import type { SchemaVersion } from './version.ts';
import {
  type ArcSeatRef, type Backend, type RiskTier, type RoutingProvenance, type SeatRef, type UnitSeatRef, arcSeatFields, backend, riskTier,
  routingProvenance, seatFields, unitSeatFields,
} from '../routing/types.ts';

// ---------------------------------------------------------------------------------------------------
// Op kinds and their payloads

/**
 * M3 adds `docs.commit` (a docs publication's rendered commit on the tip, A4), `mutant.apply` (a finding's
 * mutant applied in a detached worktree, B3) and `revision.commit` (the activation record of a revision, G1/A19:
 * named before any docs `ff`, closed once its `plan-applied` is written).
 */
export const OP_KINDS = [
  'worktree.create', 'worktree.remove', 'resource.transition', 'proc.spawn', 'proc.kill', 'evidence.snapshot',
  'salvage.commit', 'mergein.prepare', 'spec.patch', 'candidate.merge', 'integration.ff', 'snapshot.publish',
  'needsuser.raise', 'command.apply', 'docs.commit', 'mutant.apply', 'revision.commit',
] as const;
export type OpKind = (typeof OP_KINDS)[number];
export const GIT_OP_KINDS = [
  'worktree.create', 'worktree.remove', 'salvage.commit', 'mergein.prepare', 'candidate.merge', 'integration.ff',
  'snapshot.publish', 'docs.commit', 'mutant.apply',
] as const satisfies readonly OpKind[];
/** A19: the one revision fence. At most one `revision.commit` is open (its key); every revision-sensitive capture waits for it. */
export const REVISION_FENCE_KEY = 'revision';
export type GitOpKind = (typeof GIT_OP_KINDS)[number];

export type Signature = Readonly<{ name: string; email: string; date: GitDate }>;
/**
 * Every input of a commit object the executor creates, so the expected id is reproducible. `gpgsign: false`
 * records the `-c commit.gpgsign=false` the commit is made with. `P` fixes the parent count per kind.
 */
export type CommitInputs<P extends readonly Sha[]> = Readonly<{
  tree: Sha;
  parents: P;
  author: Signature;
  committer: Signature;
  message: string;
  gpgsign: false;
}>;

/**
 * Who holds a reservation: a unit's stage attempt, or a sweep command; since M2 also `retry` (a probe
 * reclaiming the unit's own residue, keyed by the stage attempt whose cleanup failed) and `publication` (the unit's
 * candidate attempt, holding `integration-slot` from candidate start through `ff` and `snapshot`; A2).
 */
export type Holder =
  | Readonly<{ type: 'stage'; unit: UnitId; stage: Stage; attempt: number }>
  | Readonly<{ type: 'sweep'; command: CommandId }>
  | Readonly<{ type: 'retry'; unit: UnitId; stage: Stage; attempt: number }>
  | Readonly<{ type: 'publication'; unit: UnitId; attempt: number }>
  /** M3 (A7): a docs publication's `integration-slot` holder, `pub` its `docs-<n>` job. */
  | Readonly<{ type: 'docs'; pub: JobId }>
  /** M3 (R7, G5, H4): a repair batch's `integration-slot` holder, per finding and candidate attempt. */
  | Readonly<{ type: 'batch'; finding: FindingId; attempt: number }>
  /** M3 (G4): a durable job's lanes (audit, baseline, docs and batch lanes); a failed cleanup leaves a job-owned residue. */
  | Readonly<{ type: 'job'; job: JobId }>;
/** The holders that may take `reclaim`: a sweep, a probe reclaiming the arc's own residue, or a job re-running its lane over its own residue (G4). */
export const RECLAIM_HOLDERS = ['sweep', 'retry', 'job'] as const satisfies readonly Holder['type'][];
/** The holders whose failed cleanup records residues (their owner: the unit, or the job). */
export const RESIDUE_HOLDERS = ['stage', 'job'] as const satisfies readonly Holder['type'][];

/** The unit a holder acts for: a stage, retry or publication holder's; none for a sweep, docs, batch or job holder. */
export function holderUnit(h: Holder): UnitId | null {
  switch (h.type) {
    case 'stage':
    case 'retry':
    case 'publication':
      return h.unit;
    case 'sweep':
    case 'docs':
    case 'batch':
    case 'job':
      return null;
  }
}

/**
 * The legal reservation edges: free→reserved, reserved→running, reserved|running→cleaning, cleaning→free,
 * cleaning→cleanup-failed, and `reclaim`: cleanup-failed→cleaning, taken only by a sweep or retry holder
 * reclaiming that resource's residue (the stage holder is gone; the reclaim re-runs the recorded teardown).
 * A `fail` lists one residue per failed resource instance (exactly the transitioned set; an `@cpu` token has
 * no teardown and never fails).
 */
export type ResourceEdge =
  | Readonly<{ type: 'reserve' }>
  | Readonly<{ type: 'reclaim' }>
  | Readonly<{ type: 'run' }>
  | Readonly<{ type: 'clean'; from: 'reserved' | 'running' }>
  | Readonly<{ type: 'release' }>
  | Readonly<{ type: 'fail'; residues: readonly Readonly<{ resource: ResourceInstance; teardown: InvocationId }>[] }>;

/** Who a journey lane (an arc lane) runs for: a unit's candidate (its stage holder), or a job. */
export type LaneOwner = Readonly<{ type: 'unit'; unit: UnitId }> | Readonly<{ type: 'job'; job: JobId }>;

/**
 * What a spawn runs. Model ids never appear: a backend is named by role and routingRev. M3: `arc-backend` (a lens
 * or checkpoint call of a job, on an arc seat), `journey` (an arc lane), `mutant` (a finding's lane on its patched tree).
 */
export type SpawnSubject =
  | (Readonly<{ purpose: 'backend'; routingRev: RoutingRev; unit: UnitId; attempt: number }> & UnitSeatRef)
  | (Readonly<{ purpose: 'arc-backend'; routingRev: RoutingRev; job: JobId; attempt: number }> & ArcSeatRef)
  | Readonly<{ purpose: 'journey'; lane: LaneId; laneRev: LaneRev; at: Sha; owner: LaneOwner }>
  | Readonly<{ purpose: 'mutant'; finding: FindingId; lane: LaneId; laneRev: LaneRev; tree: Sha }>
  | Readonly<{ purpose: 'lane'; unit: UnitId; lane: LaneId; set: 'spec' | 'suite'; at: Sha }>
  | Readonly<{ purpose: 'teardown' | 'probe'; unit: UnitId | null; resource: ResourceInstance }>
  | Readonly<{
    purpose: 'smoke';
    check: string;
    target: (Readonly<{ type: 'backend'; backend: Backend; routingRev: RoutingRev }> & SeatRef) | Readonly<{ type: 'command' }>;
  }>;

export type WorktreeCheckout =
  | Readonly<{ type: 'branch'; branch: RefName; at: Sha; createBranch: boolean }>
  | Readonly<{ type: 'detached'; at: Sha }>;

/** Recorded inputs and preconditions, per kind. Git kinds record every input of the object they create. */
export type OpExpect = {
  'worktree.create': Readonly<{ path: AbsPath; checkout: WorktreeCheckout }>;
  /** `evidence` is the done evidence.snapshot op whose manifest must be complete before removal. */
  'worktree.remove': Readonly<{ path: AbsPath; evidence: OpId }>;
  /** `resources` in lock order (`compareResourceUnits`): names and pool instances, then `@cpu#*`, `integration-slot` last. */
  'resource.transition': Readonly<{ holder: Holder; resources: readonly ResourceUnit[]; edge: ResourceEdge }>;
  /** The invocation is `op#ordinal`; launch.json is written after the intent and must hash to `launchSha256`. */
  'proc.spawn': Readonly<{ subject: SpawnSubject; launchSha256: Sha256Hex }>;
  /** `op` scope also kills stray earlier ordinals of the same op. */
  'proc.kill': Readonly<{ inv: InvocationId; scope: 'invocation' | 'op'; reason: KillReason }>;
  'evidence.snapshot': Readonly<{ source: AbsPath; globs: readonly RepoPattern[]; dest: AbsPath }>;
  'salvage.commit': Readonly<{
    worktree: AbsPath;
    branch: RefName;
    old: Sha;
    approvedSetSha256: Sha256Hex;
    rejectedManifestSha256: Sha256Hex;
    commit: CommitInputs<readonly [Sha]>;
  }>;
  'mergein.prepare': Readonly<{
    worktree: AbsPath;
    branch: RefName;
    old: Sha;
    integrationTip: Sha;
    merge:
      | Readonly<{ type: 'clean'; commit: CommitInputs<readonly [Sha, Sha]> }>
      | Readonly<{ type: 'conflicted'; conflicts: readonly RepoPath[] }>;
  }>;
  'spec.patch': Readonly<{ path: AbsPath; oldSha256: Sha256Hex; expectRev: SpecRev; patch: SpecPatch }>;
  'candidate.merge': Readonly<{
    ref: RefName;
    old: Sha | null;
    integrationTip: Sha;
    unitCommit: Sha;
    worktree: AbsPath;
    commit: CommitInputs<readonly [Sha, Sha]>;
    /**
     * M3 (R7, G5, H4): a repair batch. `commit` merges the first member onto the tip; each `chain` entry merges the
     * next member onto the previous merge (`--no-ff`); `post.new` is the last. Absent: one unit.
     */
    batch?: BatchCandidate;
  }>;
  'integration.ff': IntegrationFfExpect;
  'snapshot.publish': Readonly<{
    ref: RefName;
    old: Sha | null;
    highWater: number;
    manifestSha256: Sha256Hex;
    commit: CommitInputs<readonly [] | readonly [Sha]>;
  }>;
  /** `blocking` is recorded so the fold alone knows which raised items hold the arc (terminal predicate). */
  'needsuser.raise': Readonly<{ id: NeedsUserId; path: AbsPath; blocking: boolean }>;
  'command.apply': Readonly<{ command: CommandId; commandSha256: Sha256Hex }>;
  /** M3 (A4): the docs publication's commit of the rendered `.roadmap/` files and its contract ops on the tip, on `refs/roadmap-run/<arc>/docs/<pub>`. */
  'docs.commit': Readonly<{ ref: RefName; old: Sha | null; pub: JobId; integrationTip: Sha; worktree: AbsPath; commit: CommitInputs<readonly [Sha]> }>;
  /** M3 (B3): a finding's mutant (`inputs/<patchSha256>.patch`) applied in a detached worktree at `at`. */
  'mutant.apply': Readonly<{ worktree: AbsPath; at: Sha; finding: FindingId; patchSha256: Sha256Hex }>;
  /**
   * M3 (G1, A19): a revision's kept payload (`inputs/<payloadSha256>.revision.json`), its base and the rev it writes;
   * `base` 0 for an arc's first revision (its first start records rev 1, M3 step A2).
   */
  'revision.commit': Readonly<{ source: RevisionSource; base: RevisionBase; rev: PlanRev; payloadSha256: Sha256Hex; docs: boolean }>;
};

/** The members of a repair batch candidate and the merges chaining them. */
export type BatchCandidate = Readonly<{
  job: JobId;
  members: readonly Readonly<{ unit: UnitId; unitCommit: Sha; fingerprint: ApprovalFingerprint }>[];
  chain: readonly Readonly<{ commit: Sha; parents: readonly [Sha, Sha] }>[];
}>;

/** What an `ff` publishes besides a unit (M3): a docs publication, or a repair batch (every member's fingerprint re-checked). */
export type FfSubject = Readonly<{ type: 'docs'; pub: JobId }> | Readonly<{ type: 'batch'; job: JobId }>;
/**
 * A unit's `ff` carries its approval fingerprint and no subject (the 1.0.0-dev.5 shape); a docs or batch `ff`
 * carries its subject and no fingerprint.
 */
export type IntegrationFfExpect = Readonly<{ ref: RefName; old: Sha; new: Sha }> & (
  | Readonly<{ fingerprint: ApprovalFingerprint; subject?: never }>
  | Readonly<{ subject: FfSubject; fingerprint?: never }>
);

/** A unit `ff`'s fingerprint; a docs or batch `ff` has none, and asking for one is a bug. */
export function unitFfFingerprint(expect: IntegrationFfExpect): ApprovalFingerprint {
  if (expect.fingerprint === undefined) throw new Error(`integration.ff of ${JSON.stringify(expect.subject)} carries no unit fingerprint`);
  return expect.fingerprint;
}

/** The revision a revision is evaluated against: the plan rev in force, or 0 before the arc's first (M3 step A2). */
export type RevisionBase = PlanRev | 0;

/** Where a revision came from (G1): the arc's start, an architect command, a checkpoint bundle, or the executor's own patch. */
export type RevisionSource =
  | Readonly<{ type: 'start' }>
  | Readonly<{ type: 'command'; command: CommandId }>
  | Readonly<{ type: 'bundle'; job: JobId }>
  | Readonly<{ type: 'executor'; inv: InvocationId }>;

/** Expected postconditions beyond what the kind and `expect` already fix; `null` where they fix everything. */
export type OpPost = {
  'worktree.create': null;
  'worktree.remove': null;
  'resource.transition': null;
  'proc.spawn': null;
  'proc.kill': null;
  'evidence.snapshot': Readonly<{ manifest: AbsPath }>;
  'salvage.commit': Readonly<{ new: Sha }>;
  'mergein.prepare': Readonly<{ type: 'clean-merged'; new: Sha }> | Readonly<{ type: 'conflicted' }>;
  'spec.patch': Readonly<{ newSha256: Sha256Hex; newRev: SpecRev }>;
  'candidate.merge': Readonly<{ new: Sha }>;
  'integration.ff': null;
  'snapshot.publish': Readonly<{ new: Sha }>;
  'needsuser.raise': Readonly<{ sha256: Sha256Hex }>;
  'command.apply': null;
  'docs.commit': Readonly<{ new: Sha }>;
  'mutant.apply': null;
  'revision.commit': null;
};

export type ResultSummary =
  | Readonly<{ type: 'backend'; outcome: BackendOutcomeKind }>
  | Readonly<{ type: 'command'; verdict: CommandVerdict }>;

/** What a done record says happened, per kind. */
export type OpOutcome = {
  'worktree.create': Readonly<{ kind: 'created'; head: Sha }>;
  'worktree.remove': Readonly<{ kind: 'removed' }>;
  'resource.transition': Readonly<{ kind: 'transitioned' }>;
  'proc.spawn':
    | Readonly<{ kind: 'result'; resultSha256: Sha256Hex; summary: ResultSummary }>
    | Readonly<{ kind: 'lost'; treeEffects: boolean }>;
  'proc.kill': Readonly<{ kind: 'quiesced' }>;
  'evidence.snapshot': Readonly<{ kind: 'captured'; manifestSha256: Sha256Hex; files: number }>;
  'salvage.commit': Readonly<{ kind: 'committed' }>;
  'mergein.prepare': Readonly<{ kind: 'clean-merged' }> | Readonly<{ kind: 'conflicted' }> | Readonly<{ kind: 'completed'; head: Sha }>;
  'spec.patch': Readonly<{ kind: 'patched' }>;
  'candidate.merge': Readonly<{ kind: 'merged' }>;
  'integration.ff':
    | Readonly<{ kind: 'published' }>
    | Readonly<{ kind: 'unpublished'; tip: Sha }>
    | Readonly<{ kind: 'recovery-required'; observed: Sha | null }>;
  'snapshot.publish': Readonly<{ kind: 'published' }>;
  'needsuser.raise': Readonly<{ kind: 'raised' }>;
  'command.apply': Readonly<{ kind: 'applied'; receiptSha256: Sha256Hex }> | Readonly<{ kind: 'rejected'; reason: string }>;
  'docs.commit': Readonly<{ kind: 'committed' }>;
  /** `tree`: the patched tree's real id (G13); `inapplicable`: the patch no longer applies (re-evaluated at the next audit). */
  'mutant.apply': Readonly<{ kind: 'applied'; tree: Sha }> | Readonly<{ kind: 'inapplicable'; detail: string }>;
  /** The revision's `plan-applied` (and its divergence facts) are written. */
  'revision.commit': Readonly<{ kind: 'applied' }>;
};

// ---------------------------------------------------------------------------------------------------
// Records and envelope

export type Parent =
  | Readonly<{ type: 'stage'; unit: UnitId; stage: Stage; attempt: number }>
  | Readonly<{ type: 'command'; command: CommandId }>
  | Readonly<{ type: 'op'; op: OpId }>
  | Readonly<{ type: 'arc' }>
  /** M3: an op of a durable job (an audit's worktree, a docs publication's commit, a batch's merges). */
  | Readonly<{ type: 'job'; job: JobId }>;

/** null: closed on the normal path. Otherwise the reconciler disposition that closed it during recovery. */
export type RecoveredBy = null | 'reconciled' | 'redone' | 'adopted';

export type AbortCode = 'precondition' | 'recovery' | 'cancelled';

export type IntentOf<K extends OpKind> = Readonly<{
  type: 'intent';
  op: OpId;
  kind: K;
  key: OpKey;
  parent: Parent;
  ordinal: number;
  /** Absolute; a retry (ordinal > 1) carries its op's original deadline. */
  deadlineAt: IsoTime | null;
  expect: OpExpect[K];
  post: OpPost[K];
}>;
export type IntentRecord = { [K in OpKind]: IntentOf<K> }[OpKind];

export type DoneOf<K extends OpKind> = Readonly<{ type: 'done'; op: OpId; kind: K; outcome: OpOutcome[K]; recoveredBy: RecoveredBy }>;
export type DoneRecord = { [K in OpKind]: DoneOf<K> }[OpKind];

export type AbortRecord = Readonly<{ type: 'abort'; op: OpId; reason: Readonly<{ code: AbortCode; detail: string }> }>;

/**
 * Whom a usage fact charges: a unit's backend call at its seat (`role` and `tier` name the seat, never a
 * model; `escalation` only for a judgment role: with the fact's `routingRev` exactly one seat of that
 * revision's table, so a by-model view is exact; lead ruling, 13b), or a backend's start-up smoke, which is
 * no seat's spend.
 */
export type MeterSubject =
  | (Readonly<{ type: 'seat'; unit: UnitId; attempt: number }> & UnitSeatRef)
  | Readonly<{ type: 'smoke'; backend: Backend }>
  /** M3: a job's lens or checkpoint call, charged to the arc seat of its role. */
  | (Readonly<{ type: 'job'; job: JobId; attempt: number }> & ArcSeatRef);

// ---------------------------------------------------------------------------------------------------
// Stage outcomes: the vocabulary of the `stage-outcome` fact. The transition table itself (what each
// outcome leads to) is `src/pipeline/transitions.ts`; its `StageOutcome` union is derived from this list.

/** Every outcome a stage can report, per stage. `retire` is terminal and reports none. */
export const STAGE_OUTCOME_KINDS = {
  // A re-entered unit's preparation (M2): where the prepared worktree enters. `conflicted` keeps MERGE_HEAD and
  // enters a `resolve` round (A6).
  prepare: ['clean-plan-check', 'clean-build', 'clean-verify', 'conflicted'],
  // A vacuity repair's first stage (M3, B3): the mutant applied and its lane run. `reproduced` goes on to
  // plan-check; `not-reproduced` dismisses the finding and parks; `inapplicable` parks for the next audit.
  reproduce: ['reproduced', 'not-reproduced', 'inapplicable', 'blocked', 'interrupted', 'cleanup-failed'],
  'plan-check': ['approve', 'redirect', 'infeasible', 'escalate', 'risk-lowered', 'scope-widened', 'refusal', 'malformed', 'process-fault', 'interrupted', 'routing-changed'],
  build: ['success', 'refusal', 'malformed', 'process-fault', 'lost', 'lost-tree-effects', 'occupied', 'cleanup-failed', 'interrupted', 'routing-changed'],
  quiesce: ['empty'],
  evidence: ['captured'],
  salvage: ['committed', 'committed-contract-touched', 'unmerged', 'commit-failed'],
  teardown: ['released', 'cleanup-failed'],
  lanes: ['green', 'red', 'not-certified', 'blocked', 'interrupted', 'occupied', 'cleanup-failed'],
  gate: ['approve', 'revise', 'escalate', 'empty-diff', 'refusal', 'malformed', 'process-fault', 'interrupted', 'routing-changed'],
  // M3: `preempted` (a docs publication took the slot before green, A7, uncharged); `finding-blocked` (an active P1
  // blocks a selected obligation, at admission or the pre-ff re-check, G10; uncharged, waits for the finding).
  candidate: ['green', 'transient-violation', 'conflict', 'red', 'base-red', 'blocked', 'occupied', 'cleanup-failed', 'interrupted', 'preempted', 'finding-blocked'],
  ff: ['published', 'cas-stale', 'fingerprint-invalid', 'foreign-move'],
  snapshot: ['published'],
} as const satisfies { readonly [S in Exclude<Stage, 'retire'>]: readonly string[] };
export type OutcomeStage = keyof typeof STAGE_OUTCOME_KINDS;
export type StageOutcomeKind<S extends OutcomeStage = OutcomeStage> = (typeof STAGE_OUTCOME_KINDS)[S][number];
export const OUTCOME_STAGES = Object.keys(STAGE_OUTCOME_KINDS) as readonly OutcomeStage[];

/** Judgment stages run a fresh judgment session; a refusal or escalation there routes up the role's seats. */
export const JUDGMENT_STAGES = ['plan-check', 'gate'] as const satisfies readonly OutcomeStage[];
export type JudgmentStage = (typeof JUDGMENT_STAGES)[number];
/** Stages with an uncharged retry (malformed report, blocked lane). */
export const RETRY_STAGES = ['plan-check', 'build', 'lanes', 'gate'] as const satisfies readonly OutcomeStage[];
export type RetryStage = (typeof RETRY_STAGES)[number];

/**
 * What a recorded outcome did to the unit, as the transition table decided it; the fold derives the
 * unit's counters and status from it. `advance`: on to another stage, no counter. `redirect`, `revise`,
 * `candidate-red`: a bounded round within its bound. `retry`: the stage's one uncharged retry.
 * `route-up`: re-dispatched at the role's escalation seat. `trigger`: a risk trigger (contract path touched,
 * scope growth) that puts the next judgment dispatch on the escalation seat. `hold`: the stage was interrupted
 * (a pause or stop cancel, or its backend parked arc-wide on a usage limit); the unit stays at the stage,
 * no counter moves, and a resume re-runs the stage as a new attempt. `park`, `stop`, `retire`: the unit
 * parks (needs-user), the arc stops (needs-user), the unit is done.
 */
export const OUTCOME_CLASSES = ['advance', 'redirect', 'revise', 'candidate-red', 'retry', 'route-up', 'trigger', 'hold', 'park', 'stop', 'retire'] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/**
 * What a retryable park's probe checks (M2, parks): a backend (its smoke), the host (a clear host sample and
 * the smoke's shell command, plus each covered park's local check), or one resource instance (reclaim,
 * teardown and the residue's `cleaned` disposition, then release).
 */
export type ProbeTarget =
  | Readonly<{ type: 'backend'; backend: Backend }>
  | Readonly<{ type: 'host' }>
  | Readonly<{ type: 'resource'; instance: ResourceInstance }>;

/** A total order key over probe targets: target sets are written sorted and unique by it. */
export function probeTargetKey(t: ProbeTarget): string {
  switch (t.type) {
    case 'backend': return `backend:${t.backend}`;
    case 'host': return 'host';
    case 'resource': return `resource:${t.instance}`;
  }
}

export const OPERATOR_PARK_KINDS = ['env', 'design'] as const;
export type OperatorParkKind = (typeof OPERATOR_PARK_KINDS)[number];
/**
 * A park's class (A7), written inside the `stage-outcome` fact that parks (F9). `retryable`: the executor
 * probes `targets` and the park recovers once each has a covering passing probe. `operator`: `env` re-runs
 * the stage on `resume <unit>` (an `unparked` fact); `design` needs an applied spec revision (a reopen) or a
 * re-entry. Absent on a park 1.0.0-dev.4 wrote: read as operator, its kind by outcome (src/core/upgrade.ts).
 */
export type ParkRecord =
  | Readonly<{ class: 'retryable'; targets: readonly ProbeTarget[] }>
  | Readonly<{ class: 'operator'; kind: OperatorParkKind }>;

/**
 * Why a stage was interrupted, when not an operator pause or stop (G5): its backend parked, at the park fact's
 * seq. A covering passing probe or `resume --backend` releases exactly such holds; operator pauses stay.
 */
export type HoldCause = Readonly<{ type: 'backend'; backend: Backend; parkSeq: number }>;

/**
 * One per (unit, stage, attempt). `chargeable` marks a design-class failure (the table's C rows); the
 * third one bounds the unit, so its class must be `park`. `park` (M2) only with class `park`; `cause` (M2)
 * only with class `hold`, absent for a pause or stop.
 */
export type StageOutcomeFact = { [S in OutcomeStage]: Readonly<{
  kind: 'stage-outcome';
  unit: UnitId;
  stage: S;
  attempt: number;
  outcome: StageOutcomeKind<S>;
  class: OutcomeClass;
  chargeable: boolean;
  park?: ParkRecord;
  cause?: HoldCause;
}> }[OutcomeStage];

/**
 * What a judgment stage attempt was admitted with (F1), written after its entry reservation and before its
 * backend spawn. A recovered call is consumed against these, never the current tip or plan.
 */
export type JudgmentInputs = Readonly<{
  unit: UnitId;
  stage: JudgmentStage;
  attempt: number;
  /** The integration tip the judgment read. */
  tip: Sha;
  /** The unit commit it read (the gate); null for a plan-check. */
  head: Sha | null;
  specRev: SpecRev;
  specSha256: Sha256Hex;
  planRev: PlanRev;
  routingRev: RoutingRev;
  /**
   * M3 (Checkpoint A): the gate's complete approval fingerprint, captured with its other inputs under the revision
   * fence; an approval records exactly it. Absent on a plan-check's, and on a gate's a 1.0.0-dev.5 executor wrote
   * (read-time default: taken at the recorded tip when the call is read, `judgmentFingerprintDefault`).
   */
  fingerprint?: ApprovalFingerprint;
}>;

export type Fact =
  | Readonly<{ kind: 'tail-discarded'; offset: number; length: number; sha256: Sha256Hex }>
  | Readonly<{ kind: 'containment-mode'; mode: ContainmentMode }>
  /** One usage fact per invocation, charged to `subject`. */
  | Readonly<{ kind: 'meter'; inv: InvocationId; routingRev: RoutingRev; subject: MeterSubject; usage: TokenUsage }>
  | Readonly<{ kind: 'usage-unavailable'; inv: InvocationId; routingRev: RoutingRev; subject: MeterSubject; reason: UsageUnavailableReason }>
  | Readonly<{ kind: 'dispatch'; record: DispatchRecord }>
  /**
   * A backend is parked arc-wide: a failed invocation reported a usage-limit or capacity error (`inv`, the
   * invocation whose result carried it), or its smoke failed on a supervisor respawn (`outage`, `inv` null;
   * A18). The fact's seq is the park's epoch (F12): a usage-limit park dominates until `resume --backend`; a
   * retryable one (capacity, outage) clears on a passing probe covering exactly the current epoch.
   */
  | Readonly<{ kind: 'backend-park'; backend: Backend; class: BackendParkClass; inv: InvocationId | null }>
  /**
   * Command effects (step 13), each written once by the `command.apply` op of `command`. `needs-user-acked`:
   * the item is acknowledged (at most once per id; its `.ack.json` is the file twin). `paused` and
   * `stop-requested`: the durable control markers the driver consults. `resumed`: a unit's or every hold
   * and pause cleared, or a backend's park cleared after a passing smoke.
   */
  | Readonly<{ kind: 'needs-user-acked'; id: NeedsUserId; command: CommandId; choice: string | null }>
  | Readonly<{ kind: 'paused'; command: CommandId; target: PauseTarget }>
  | Readonly<{ kind: 'stop-requested'; command: CommandId }>
  | Readonly<{ kind: 'resumed'; command: CommandId; target: ResumeTarget }>
  /**
   * A unit re-opened on a spec revision the architect applied (`specRev`, the unit's recorded spec rev + 1,
   * whose bytes hash to `specSha256`): by `resume <unit>` of a unit parked at a judgment stage (`command`: the
   * resume), or by the driver at an in-flight unit's next stage boundary that allows it (`command`: the apply
   * that recorded the revision, null for a start). The unit re-enters at plan-check as a new attempt; its
   * counters are kept, and the redirect bound counts from here.
   */
  | Readonly<{ kind: 'reopened'; unit: UnitId; command: CommandId | null; specRev: SpecRev; specSha256: Sha256Hex }>
  /**
   * A new plan in force (`roadmap apply`, or a `start` whose plan.json differs): revision `rev` (1 for the first
   * plan the arc ran, then one more each), the files' hashes (`PlanManifest`; the bytes are kept as
   * `inputs/<sha256>.plan.json` and `.spec.json`), the command that applied it (null for a start) and what
   * changed against the previous revision. The postcondition of an `apply`: written once, last.
   */
  /**
   * `scheduling: 'dag'` (M2) only on rev 1, and only in a log with no `dispatch` fact: the arc runs DAG
   * scheduling. Absent on rev 1, the arc is legacy (started on 1.0.0-dev.4 or earlier): it keeps that release's
   * serial frontier (`legacyNext`, src/core/upgrade.ts).
   */
  | (Readonly<{ kind: 'plan-applied'; rev: PlanRev; command: CommandId | null; changes: readonly PlanChange[]; scheduling?: 'dag' }> & PlanManifest & PlanAppliedM3)
  /**
   * `resume <unit>` re-entered a unit parked `routing-changed` once the routing in force lets it keep its
   * implementer seat (a `dispatch` fact re-pinned it first). The unit re-enters at the stage it parked at as
   * a new, uncharged attempt: its decision and interruption return to what they were before the park. Written
   * through 1.0.0-dev.4; since M2 read as `unparked` (src/core/upgrade.ts).
   */
  | Readonly<{ kind: 'rerouted'; unit: UnitId; command: CommandId }>
  /**
   * `resume <unit>` re-entered a unit parked operator-env (M2): the unit re-runs the stage it parked at as a new,
   * uncharged attempt; its decision and interruption return to what they were before the park.
   */
  | Readonly<{ kind: 'unparked'; unit: UnitId; command: CommandId }>
  /**
   * A probe (M2): `target` checked for the seqs `covers` (sorted, non-empty): unit parks' stage-outcome seqs, a
   * backend park's seq, and for a resource target the seq of the `resource.transition{fail}` that left an own-arc
   * residue on it (residue probing, which needs no park). A pass recovers the parks it covers once every target
   * of each has passed; `nextProbeAt` is when a failed target is probed again (null exactly on a pass).
   */
  | Readonly<{ kind: 'probe'; target: ProbeTarget; covers: readonly number[]; result: 'pass' | 'fail'; nextProbeAt: IsoTime | null }>
  | (Readonly<{ kind: 'judgment-inputs' }> & JudgmentInputs)
  /** `resolve-edge` (M2): a contingent edge's condition is met, on the architect's evidence; once per edge. */
  | Readonly<{ kind: 'edge-resolved'; edge: EdgeId; command: CommandId; evidence: string }>
  /** `run-only` (M2): admission is limited to `units` (sorted), or unlimited again (null). */
  | Readonly<{ kind: 'run-only'; command: CommandId; units: readonly UnitId[] | null }>
  /**
   * A fix round after a stalled one runs cold on the `build.high` seat (A11, G1): written before that round's
   * implementer seat is chosen. `attempt` is the escalated build attempt, `stalled` the build attempt whose
   * round stalled, `from` the unit's build tier until now.
   */
  | Readonly<{ kind: 'implementer-escalated'; unit: UnitId; attempt: number; from: RiskTier; to: 'high'; stalled: number }>
  /**
   * An executor started under host generation `generation` (step 13b), written at every start once the
   * journal is open. It clears the stop marker: a stop ends one run, not the arc. Pause markers and holds
   * persist until a `resume`.
   */
  | Readonly<{ kind: 'executor-started'; generation: number }>
  /**
   * The gate at `attempt` approved the unit, bound to `fingerprint` (R2): recorded before its stage-outcome,
   * read by the candidate and ff stages, and re-checked at T before `integration.ff`.
   */
  | Readonly<{ kind: 'approval'; unit: UnitId; attempt: number; fingerprint: ApprovalFingerprint }>
  | StageOutcomeFact
  | HolisticFact;
export type FactRecord = Readonly<{ type: 'fact'; fact: Fact }>;

/**
 * M3 fields of `plan-applied`, all absent on a 1.0.0-dev.5 fact and written on every M3 revision:
 * `source` (G1; absent: `start` for a null command, else `command`, `revisionSourceOf`); `payloadSha256` (the kept
 * `inputs/<sha>.revision.json` it was appended from); the ledger's, obligations' and vision's bytes in force
 * (`rulingsSha256` absent: the ledger is read live, `rulingsFromLiveFile`; `visionSha256` present exactly while the
 * arc is holistic); `publication` (the docs publication that carried it); `routingProvenance` (H7).
 */
export type PlanAppliedM3 = Readonly<{
  source?: RevisionSource;
  payloadSha256?: Sha256Hex;
  rulingsSha256?: Sha256Hex;
  obligationsSha256?: Sha256Hex;
  visionSha256?: Sha256Hex;
  publication?: Readonly<{ pub: JobId; head: Sha }>;
  routingProvenance?: RoutingProvenance;
}>;

/** Whom a witness run certified or measured: a candidate, a job (audit, baseline, docs, batch), or a mutant (G13). */
export type WitnessFor =
  | Readonly<{ type: 'candidate'; unit: UnitId; attempt: number }>
  | Readonly<{ type: 'job'; job: JobId }>
  | Readonly<{ type: 'mutant'; finding: FindingId; of: Sha }>;

/** An audit's immutable inputs (§2.5), captured under the revision fence (A19, H2). */
export type AuditInputs = Readonly<{
  job: JobId;
  triggers: readonly AuditTrigger[];
  generation: number;
  /** The lenses it runs, ascending: a subset of the arc's required set L. */
  lenses: readonly LensKindName[];
  integrationSha: Sha;
  planRev: PlanRev;
  ledgerSha256: Sha256Hex | null;
  obligationsSha256: Sha256Hex | null;
  visionSha256: Sha256Hex;
  /** Branch heads of parked or in-flight owners of open findings, ascending by unit. */
  owners: readonly Readonly<{ unit: UnitId; head: Sha }>[];
  priorFindings: readonly FindingId[];
  highWater: number;
}>;

/** One lens's covered range: `from` its watermark before, `to` the audited SHA. */
export type CoveredRange = Readonly<{ lens: LensKindName; from: Sha; to: Sha }>;

/** The M3 facts (SCHEMAS.md "M3: the holistic layer"). */
export type HolisticFact =
  /** A witness run's records (`witness.json`, hashed): the observation key and whom it ran for. */
  | Readonly<{ kind: 'witnessed'; lane: LaneId; laneRev: LaneRev; envId: EnvId; treeSha: Sha; inv: InvocationId; recordsSha256: Sha256Hex; purpose: WitnessPurpose; for: WitnessFor }>
  /** A future obligation delivered and held on its publication: it is must-hold from here (after `ff{published}`, before the snapshot). */
  | Readonly<{ kind: 'obligation-latched'; obligation: ObligationId; unit: UnitId; treeSha: Sha }>
  | Readonly<{
    kind: 'finding-opened'; id: FindingId; key: Sha256Hex; lens: FindingLens; severity: FindingSeverity; obligation: ObligationId | null;
    visionClauses: readonly VisionClauseId[]; claim: string; evidence: readonly FindingEvidence[]; mutant: MutantRef | null; source: FindingSource;
    gateHadPassed: boolean;
  }>
  | Readonly<{ kind: 'finding-transition'; id: FindingId; to: FindingTo }>
  | (Readonly<{ kind: 'audit-started' }> & AuditInputs)
  | Readonly<{ kind: 'audit-ended'; job: JobId; covered: readonly CoveredRange[]; findings: readonly FindingId[]; suppressed: number; outcome: 'completed' | 'abandoned' }>
  /** A17, H8: a docs-only publication covers its own edge U→D by construction. */
  | Readonly<{ kind: 'docs-covered'; pub: JobId; from: Sha; to: Sha }>
  | Readonly<{
    kind: 'checkpoint-inputs'; job: JobId; trigger: CheckpointTrigger; generation: number; vector: RevisionVector; headSha: Sha; visionSha256: Sha256Hex;
    findings: readonly FindingId[]; observations: readonly ObservationKey[];
  }>
  | Readonly<{ kind: 'bundle-decided'; job: JobId; outcome: BundleOutcome }>
  /** OR-V.6: `index` orders a job's divergences, so a rewrite after a crash is idempotent (H12). */
  | (Readonly<{ kind: 'divergence'; id: DivergenceId; index: number }> & DivergenceDraft)
  /** H11: the digest item binds exactly these ids; its acknowledgement covers them. */
  | Readonly<{ kind: 'divergence-digest'; needsUser: NeedsUserId; ids: readonly DivergenceId[] }>
  | Readonly<{ kind: 'steered'; unit: UnitId; command: CommandId; brief: Sha256Hex; budgetMin: number; resume: boolean }>
  | Readonly<{ kind: 'merged-in'; unit: UnitId; command: CommandId; integrationTip: Sha; head: Sha }>
  | Readonly<{ kind: 'audit-requested'; command: CommandId; lenses: readonly LensKindName[] | null }>
  | Readonly<{ kind: 'admissions-closed'; command: CommandId }>
  | Readonly<{ kind: 'docs-published'; pub: JobId; source: 'close-out'; commit: Sha }>
  /** A20: active while the plan rev and the integration head are unchanged; `units` the merged units, ascending. */
  | Readonly<{ kind: 'arc-completed'; planRev: PlanRev; head: Sha; highWater: number; units: readonly UnitId[] }>;

export type HolisticFactKind = HolisticFact['kind'];
export type PlanAppliedFact = Extract<Fact, { kind: 'plan-applied' }>;

/** The plan fields besides units, suite, resources and routing that an apply may change. `capacity` since M2. */
export const PLAN_FIELDS = ['contracts', 'rulings', 'architectureDoc', 'architectureDigest', 'direction', 'capacity'] as const;
export type PlanField = (typeof PLAN_FIELDS)[number];

/**
 * How a unit's spec changed: before its first dispatch (`undispatched`); only lane evidenceGlobs or
 * evidenceExcludes at its current rev (`evidence`: in force at once); the next rev of a dispatched unit
 * (`revision`: pending until the unit re-opens on it, see `reopened`); or a pending revision taken back
 * (`withdrawn`: the spec is the unit's recorded one again).
 */
export const SPEC_EDITS = ['undispatched', 'evidence', 'revision', 'withdrawn'] as const;
export type SpecEdit = (typeof SPEC_EDITS)[number];

/** One change of a `plan-applied` fact against the previous plan in force (SCHEMAS.md "Plan in force"). */
export type PlanChange =
  | Readonly<{ type: 'unit-added' | 'unit-removed' | 'unit-changed'; unit: UnitId }>
  /** The undispatched units' order changed. */
  | Readonly<{ type: 'order' }>
  | Readonly<{ type: 'spec'; unit: UnitId; edit: SpecEdit; specRev: SpecRev; specSha256: Sha256Hex }>
  /** The routing in force; `unit` (M3, `route`/`steer --class`): that unit's layer changed, and `routingRev` is its routing's. */
  | Readonly<{ type: 'routing'; routingRev: RoutingRev; unit?: UnitId }>
  | Readonly<{ type: 'resource'; resource: ResourceName; edit: 'added' | 'changed' | 'removed' }>
  | Readonly<{ type: 'suite' }>
  | Readonly<{ type: 'plan-field'; field: PlanField }>
  /** M2: a unit cut (`cut{reason, ruling?}`): out of scope, never dispatched again; its dependents dropped the edge or were cut too. */
  | Readonly<{ type: 'unit-cut'; unit: UnitId }>
  /**
   * M2: `unit` (added in the same change set) re-enters `reenters`, which is superseded: the new unit inherits its
   * counters (`chargeableFailures` reset only with a ruling: `reset`), risk floor and lineage.
   */
  | Readonly<{ type: 'unit-reentered'; unit: UnitId; reenters: UnitId; reset: boolean }>
  /** M3: an obligation added, split (H14), re-witnessed, or disposed by a ruling in force (weakening). */
  | Readonly<{ type: 'obligation'; id: ObligationId; edit: ObligationEdit }>
  | Readonly<{ type: 'mapping' }>
  /** M3: the vision's new `rev` (owner-only: source `command`). */
  | Readonly<{ type: 'vision'; rev: number }>
  /** M3: a unit's `limits`, or the plan's (null). */
  | Readonly<{ type: 'limits'; unit: UnitId | null }>
  /** M3 (A5): the plan gained `holistic`. */
  | Readonly<{ type: 'holistic' }>;

/**
 * `restored` (M3 step A2): an exempt obligation active again; `edited`: its serves, contracts, deliveredBy changed, or
 * future → must-hold (strengthening, no ruling needed).
 */
export const OBLIGATION_EDITS = ['added', 'split', 'witness', 'disposed', 'restored', 'edited'] as const;
export type ObligationEdit = (typeof OBLIGATION_EDITS)[number];

/**
 * A revision's full evaluated payload (G1), kept content-addressed as `inputs/<sha256>.revision.json` and named by
 * its `revision.commit` intent before any docs `ff`. `plan-applied` is appended from it exactly, then its
 * divergences in order; recovery never reclassifies. `publication`: the rendered `.roadmap/` files and the contract
 * ops the docs publication commits, null when the revision changes no in-tree document.
 */
export type RevisionPayload = Readonly<{
  v: SchemaVersion;
  source: RevisionSource;
  base: RevisionBase;
  rev: PlanRev;
  manifest: RevisionManifest;
  changes: readonly PlanChange[];
  dispositions: readonly Readonly<{ obligation: ObligationId; disposition: ObligationDisposition; ruling: RulingId }>[];
  divergences: readonly DivergenceDraft[];
  publication: Readonly<{ renders: readonly Readonly<{ path: RepoPath; sha256: Sha256Hex }>[]; contractOps: readonly ContractOp[] }> | null;
  routingProvenance: RoutingProvenance;
}>;

/**
 * The backend park classes (lead ruling, 11b; F12). `usage-limit` is an operator park (`resume --backend`,
 * owner ruling D4); `capacity` and `outage` are retryable (probed).
 */
export const BACKEND_PARK_CLASSES = ['usage-limit', 'capacity', 'outage'] as const;
export type BackendParkClass = (typeof BACKEND_PARK_CLASSES)[number];
export const RETRYABLE_BACKEND_PARKS = ['capacity', 'outage'] as const satisfies readonly BackendParkClass[];

export type LogRecord = IntentRecord | DoneRecord | AbortRecord | FactRecord;

/**
 * The unit an op works for, for crash attribution (G8: `crashPoint(label, unit)`): a stage parent's unit,
 * followed through op parents (a kill's spawn) when `latestIntent` is given; undefined for an arc or command op.
 */
export function parentUnit(parent: Parent, latestIntent?: (op: OpId) => IntentRecord): UnitId | undefined {
  if (parent.type === 'stage') return parent.unit;
  if (parent.type === 'op' && latestIntent !== undefined) return parentUnit(latestIntent(parent.op).parent, latestIntent);
  return undefined;
}

/**
 * A log record's unit, for crash attribution (G8): an intent's parent's, a done's or abort's op's, a fact's own
 * `unit`, a usage fact's invocation's op's; undefined for arc-level records. `latestIntent` reads the fold the record
 * is appended to (a done's intent is already in it).
 */
export function recordUnit(record: LogRecord, latestIntent: (op: OpId) => IntentRecord): UnitId | undefined {
  switch (record.type) {
    case 'intent':
      return parentUnit(record.parent, latestIntent);
    case 'done':
    case 'abort':
      return parentUnit(latestIntent(record.op).parent, latestIntent);
    case 'fact': {
      const f = record.fact;
      if ('unit' in f && typeof f.unit === 'string') return f.unit;
      // A usage fact always follows its spawn's intent; a backend park's `inv` is only a pointer, never followed.
      if (f.kind === 'meter' || f.kind === 'usage-unavailable') return parentUnit(latestIntent(parseInvocationId(f.inv).op).parent, latestIntent);
      return undefined;
    }
  }
}

/** `prev` is null exactly on seq 1. */
export type Envelope = Readonly<{ v: SchemaVersion; seq: number; prev: Sha256Hex | null; at: IsoTime; arc: ArcId }>;
export type Event = Envelope & LogRecord;

// ---------------------------------------------------------------------------------------------------
// Readers

const shaR: Read<Sha> = (v, p) => sha(v, p);
const sha256R: Read<Sha256Hex> = (v, p) => sha256(v, p);
const absR: Read<AbsPath> = (v, p) => absPath(v, p);
const refR: Read<RefName> = (v, p) => refName(v, p);
const unitR: Read<UnitId> = (v, p) => unitId(v, p);
const opR: Read<OpId> = (v, p) => opIdOf(v, p);
const invR: Read<InvocationId> = (v, p) => invocationIdOf(v, p);
const revR: Read<RoutingRev> = (v, p) => routingRev(v, p);
const resR: Read<ResourceName> = (v, p) => resourceName(v, p);
const instR: Read<ResourceInstance> = (v, p) => resourceInstance(v, p);
const unitResR: Read<ResourceUnit> = (v, p) => resourceUnit(v, p);
const cmdR: Read<CommandId> = (v, p) => commandId(v, p);
const specRevR: Read<SpecRev> = (v, p) => specRev(v, p);

const signature: Read<Signature> = object((f) => ({ name: f.get('name', str), email: f.get('email', text), date: f.get('date', (v, p) => gitDate(v, p)) }));

function commitInputs<P extends readonly Sha[]>(parentCount: readonly number[]): Read<CommitInputs<P>> {
  return object((f) => {
    const parents = f.get('parents', arrayOf(shaR));
    if (!parentCount.includes(parents.length)) throw new SchemaError(`${f.path}.parents`, `${parentCount.join(' or ')} parents`, parents);
    return {
      tree: f.get('tree', shaR),
      parents: parents as unknown as P,
      author: f.get('author', signature),
      committer: f.get('committer', signature),
      message: f.get('message', text),
      gpgsign: f.get('gpgsign', literal(false)),
    };
  });
}

function sameList(actual: readonly string[], expected: readonly string[], path: string): void {
  if (actual.length !== expected.length || actual.some((s, i) => s !== expected[i])) {
    throw new SchemaError(path, JSON.stringify(expected), actual);
  }
}

/** Lock order (`compareResourceUnits`): strictly ascending, so `integration-slot`, when present, is last. */
const lockOrder: Read<readonly ResourceUnit[]> = (value, path) => {
  const list = arrayOf(unitResR, { nonEmpty: true })(value, path);
  for (let i = 1; i < list.length; i++) {
    if (!(compareResourceUnits(list[i - 1] as ResourceUnit, list[i] as ResourceUnit) < 0)) {
      throw new SchemaError(`${path}[${i}]`, 'lock order (names and pool instances ascending, then @cpu tokens, integration-slot last), no duplicates', value);
    }
  }
  return list;
};

const jobR: Read<JobId> = (v, p) => jobIdOf(v, p);
const docsJobR: Read<JobId> = (v, p) => jobIdOfKind('docs')(v, p);
const batchJobR: Read<JobId> = (v, p) => jobIdOfKind('batch')(v, p);
const findingR: Read<FindingId> = (v, p) => findingId(v, p);
const obligationR: Read<ObligationId> = (v, p) => obligationId(v, p);
const laneR: Read<LaneId> = (v, p) => laneId(v, p);
const laneRevR: Read<LaneRev> = (v, p) => laneRev(v, p);
const planRevR: Read<PlanRev> = (v, p) => planRev(v, p);
const revisionBaseR: Read<RevisionBase> = (v, p) => (v === 0 ? 0 : planRev(v, p));

const holder: Read<Holder> = tagged('type', {
  stage: object((f): Holder => ({ type: f.get('type', literal('stage')), unit: f.get('unit', unitR), stage: f.get('stage', stage), attempt: f.get('attempt', positive) })),
  sweep: object((f): Holder => ({ type: f.get('type', literal('sweep')), command: f.get('command', cmdR) })),
  retry: object((f): Holder => ({ type: f.get('type', literal('retry')), unit: f.get('unit', unitR), stage: f.get('stage', stage), attempt: f.get('attempt', positive) })),
  publication: object((f): Holder => ({ type: f.get('type', literal('publication')), unit: f.get('unit', unitR), attempt: f.get('attempt', positive) })),
  docs: object((f): Holder => ({ type: f.get('type', literal('docs')), pub: f.get('pub', docsJobR) })),
  batch: object((f): Holder => ({ type: f.get('type', literal('batch')), finding: f.get('finding', findingR), attempt: f.get('attempt', positive) })),
  job: object((f): Holder => ({ type: f.get('type', literal('job')), job: f.get('job', jobR) })),
});

const laneOwner: Read<LaneOwner> = tagged('type', {
  unit: object((f): LaneOwner => ({ type: f.get('type', literal('unit')), unit: f.get('unit', unitR) })),
  job: object((f): LaneOwner => ({ type: f.get('type', literal('job')), job: f.get('job', jobR) })),
});

const revisionSource: Read<RevisionSource> = tagged('type', {
  start: object((f): RevisionSource => ({ type: f.get('type', literal('start')) })),
  command: object((f): RevisionSource => ({ type: f.get('type', literal('command')), command: f.get('command', cmdR) })),
  bundle: object((f): RevisionSource => ({ type: f.get('type', literal('bundle')), job: f.get('job', (v, p) => jobIdOfKind('ckpt')(v, p)) })),
  executor: object((f): RevisionSource => ({ type: f.get('type', literal('executor')), inv: f.get('inv', invR) })),
});

const resourceEdge: Read<ResourceEdge> = tagged('type', {
  reserve: object((f): ResourceEdge => ({ type: f.get('type', literal('reserve')) })),
  reclaim: object((f): ResourceEdge => ({ type: f.get('type', literal('reclaim')) })),
  run: object((f): ResourceEdge => ({ type: f.get('type', literal('run')) })),
  clean: object((f): ResourceEdge => ({ type: f.get('type', literal('clean')), from: f.get('from', oneOf(['reserved', 'running'] as const)) })),
  release: object((f): ResourceEdge => ({ type: f.get('type', literal('release')) })),
  fail: object((f): ResourceEdge => ({
    type: f.get('type', literal('fail')),
    residues: f.get('residues', arrayOf(object((g) => ({ resource: g.get('resource', instR), teardown: g.get('teardown', invR) })), { nonEmpty: true })),
  })),
});

const spawnSubject: Read<SpawnSubject> = tagged('purpose', {
  backend: object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('backend')), ...unitSeatFields(f), routingRev: f.get('routingRev', revR),
    unit: f.get('unit', unitR), attempt: f.get('attempt', positive),
  })),
  'arc-backend': object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('arc-backend')), ...arcSeatFields(f), routingRev: f.get('routingRev', revR),
    job: f.get('job', jobR), attempt: f.get('attempt', positive),
  })),
  journey: object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('journey')), lane: f.get('lane', laneR), laneRev: f.get('laneRev', laneRevR), at: f.get('at', shaR),
    owner: f.get('owner', laneOwner),
  })),
  mutant: object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('mutant')), finding: f.get('finding', findingR), lane: f.get('lane', laneR), laneRev: f.get('laneRev', laneRevR),
    tree: f.get('tree', shaR),
  })),
  lane: object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('lane')), unit: f.get('unit', unitR), lane: f.get('lane', (v, p): LaneId => laneId(v, p)),
    set: f.get('set', oneOf(['spec', 'suite'] as const)), at: f.get('at', shaR),
  })),
  teardown: object((f): SpawnSubject => ({ purpose: f.get('purpose', literal('teardown')), unit: f.get('unit', nullable(unitR)), resource: f.get('resource', instR) })),
  probe: object((f): SpawnSubject => ({ purpose: f.get('purpose', literal('probe')), unit: f.get('unit', nullable(unitR)), resource: f.get('resource', instR) })),
  smoke: object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('smoke')),
    check: f.get('check', str),
    target: f.get('target', tagged<'backend' | 'command', Extract<SpawnSubject, { purpose: 'smoke' }>['target']>('type', {
      backend: object((g) => ({
        type: g.get('type', literal('backend')), backend: g.get('backend', backend), ...seatFields(g),
        routingRev: g.get('routingRev', revR),
      })),
      command: object((g) => ({ type: g.get('type', literal('command')) })),
    })),
  })),
});

const worktreeCheckout: Read<WorktreeCheckout> = tagged('type', {
  branch: object((f): WorktreeCheckout => ({ type: f.get('type', literal('branch')), branch: f.get('branch', refR), at: f.get('at', shaR), createBranch: f.get('createBranch', bool) })),
  detached: object((f): WorktreeCheckout => ({ type: f.get('type', literal('detached')), at: f.get('at', shaR) })),
});

const resultSummary: Read<ResultSummary> = tagged('type', {
  backend: object((f): ResultSummary => ({ type: f.get('type', literal('backend')), outcome: f.get('outcome', oneOf(['success', 'refusal', 'malformed', 'process-fault', 'cancelled'] as const)) })),
  command: object((f): ResultSummary => ({ type: f.get('type', literal('command')), verdict: f.get('verdict', oneOf(COMMAND_VERDICTS)) })),
});

const kindOnly = <K extends string>(kind: K) => object((f) => ({ kind: f.get('kind', literal(kind)) }));
const nothing: Read<null> = literal(null);

type OpSchema<K extends OpKind> = Readonly<{
  expect: Read<OpExpect[K]>;
  post: Read<OpPost[K]>;
  outcome: Read<OpOutcome[K]>;
  /** Cross-field rules between expect and post that the types cannot state. */
  check?: (expect: OpExpect[K], post: OpPost[K], path: string) => void;
}>;

export const OP_SCHEMAS: { readonly [K in OpKind]: OpSchema<K> } = {
  'worktree.create': {
    expect: object((f) => ({ path: f.get('path', absR), checkout: f.get('checkout', worktreeCheckout) })),
    post: nothing,
    outcome: object((f) => ({ kind: f.get('kind', literal('created')), head: f.get('head', shaR) })),
  },
  'worktree.remove': {
    expect: object((f) => ({ path: f.get('path', absR), evidence: f.get('evidence', opR) })),
    post: nothing,
    outcome: kindOnly('removed'),
  },
  'resource.transition': {
    expect: object((f) => ({ holder: f.get('holder', holder), resources: f.get('resources', lockOrder), edge: f.get('edge', resourceEdge) })),
    post: nothing,
    outcome: kindOnly('transitioned'),
    check: (e, _post, path) => {
      if (e.edge.type === 'reclaim' && !(RECLAIM_HOLDERS as readonly string[]).includes(e.holder.type)) {
        throw new SchemaError(`${path}.expect.holder.type`, `${RECLAIM_HOLDERS.join(' or ')} (only these reclaim a cleanup-failed resource)`, e.holder.type);
      }
      if (e.edge.type !== 'fail') return;
      sameList(e.edge.residues.map((r) => r.resource), e.resources, `${path}.expect.edge.residues`);
    },
  },
  'proc.spawn': {
    expect: object((f) => ({ subject: f.get('subject', spawnSubject), launchSha256: f.get('launchSha256', sha256R) })),
    post: nothing,
    outcome: tagged('kind', {
      result: object((f): OpOutcome['proc.spawn'] => ({ kind: f.get('kind', literal('result')), resultSha256: f.get('resultSha256', sha256R), summary: f.get('summary', resultSummary) })),
      lost: object((f): OpOutcome['proc.spawn'] => ({ kind: f.get('kind', literal('lost')), treeEffects: f.get('treeEffects', bool) })),
    }),
  },
  'proc.kill': {
    expect: object((f) => ({ inv: f.get('inv', invR), scope: f.get('scope', oneOf(['invocation', 'op'] as const)), reason: f.get('reason', killReason) })),
    post: nothing,
    outcome: kindOnly('quiesced'),
  },
  'evidence.snapshot': {
    expect: object((f) => ({ source: f.get('source', absR), globs: f.get('globs', arrayOf((v, p) => repoPattern(v, p))), dest: f.get('dest', absR) })),
    post: object((f) => ({ manifest: f.get('manifest', absR) })),
    outcome: object((f) => ({ kind: f.get('kind', literal('captured')), manifestSha256: f.get('manifestSha256', sha256R), files: f.get('files', nat) })),
  },
  'salvage.commit': {
    expect: object((f) => ({
      worktree: f.get('worktree', absR),
      branch: f.get('branch', refR),
      old: f.get('old', shaR),
      approvedSetSha256: f.get('approvedSetSha256', sha256R),
      rejectedManifestSha256: f.get('rejectedManifestSha256', sha256R),
      commit: f.get('commit', commitInputs<readonly [Sha]>([1])),
    })),
    post: object((f) => ({ new: f.get('new', shaR) })),
    outcome: kindOnly('committed'),
    check: (e, _post, path) => sameList(e.commit.parents, [e.old], `${path}.expect.commit.parents`),
  },
  'mergein.prepare': {
    expect: object((f) => ({
      worktree: f.get('worktree', absR),
      branch: f.get('branch', refR),
      old: f.get('old', shaR),
      integrationTip: f.get('integrationTip', shaR),
      merge: f.get('merge', tagged<'clean' | 'conflicted', OpExpect['mergein.prepare']['merge']>('type', {
        clean: object((g) => ({ type: g.get('type', literal('clean')), commit: g.get('commit', commitInputs<readonly [Sha, Sha]>([2])) })),
        conflicted: object((g) => ({ type: g.get('type', literal('conflicted')), conflicts: g.get('conflicts', arrayOf((v, p) => repoPath(v, p), { nonEmpty: true })) })),
      })),
    })),
    post: tagged('type', {
      'clean-merged': object((f): OpPost['mergein.prepare'] => ({ type: f.get('type', literal('clean-merged')), new: f.get('new', shaR) })),
      conflicted: object((f): OpPost['mergein.prepare'] => ({ type: f.get('type', literal('conflicted')) })),
    }),
    outcome: tagged('kind', {
      'clean-merged': kindOnly('clean-merged'),
      conflicted: kindOnly('conflicted'),
      completed: object((f): OpOutcome['mergein.prepare'] => ({ kind: f.get('kind', literal('completed')), head: f.get('head', shaR) })),
    }),
    check: (e, post, path) => {
      if ((e.merge.type === 'clean') !== (post.type === 'clean-merged')) throw new SchemaError(`${path}.post.type`, `the post matching merge type ${e.merge.type}`, post.type);
      if (e.merge.type === 'clean') sameList(e.merge.commit.parents, [e.old, e.integrationTip], `${path}.expect.merge.commit.parents`);
    },
  },
  'spec.patch': {
    expect: object((f) => ({ path: f.get('path', absR), oldSha256: f.get('oldSha256', sha256R), expectRev: f.get('expectRev', specRevR), patch: f.get('patch', specPatch) })),
    post: object((f) => ({ newSha256: f.get('newSha256', sha256R), newRev: f.get('newRev', specRevR) })),
    outcome: kindOnly('patched'),
    check: (e, post, path) => {
      if (e.patch.expectRev !== e.expectRev) throw new SchemaError(`${path}.expect.patch.expectRev`, String(e.expectRev), e.patch.expectRev);
      if (post.newRev !== e.expectRev + 1) throw new SchemaError(`${path}.post.newRev`, String(e.expectRev + 1), post.newRev);
    },
  },
  'candidate.merge': {
    expect: object((f) => {
      const batch = f.optional('batch', batchCandidate);
      return {
        ref: f.get('ref', refR),
        old: f.get('old', nullable(shaR)),
        integrationTip: f.get('integrationTip', shaR),
        unitCommit: f.get('unitCommit', shaR),
        worktree: f.get('worktree', absR),
        commit: f.get('commit', commitInputs<readonly [Sha, Sha]>([2])),
        ...(batch === undefined ? {} : { batch }),
      };
    }),
    post: object((f) => ({ new: f.get('new', shaR) })),
    outcome: kindOnly('merged'),
    check: (e, post, path) => {
      if (!/^refs\/roadmap-run\/[^/]+\/candidate\/[^/]+$/.test(e.ref)) throw new SchemaError(`${path}.expect.ref`, 'refs/roadmap-run/<arc>/candidate/<unit>', e.ref);
      sameList(e.commit.parents, [e.integrationTip, e.unitCommit], `${path}.expect.commit.parents`);
      if (e.batch === undefined) return;
      const { members, chain } = e.batch;
      if (members[0]?.unitCommit !== e.unitCommit) throw new SchemaError(`${path}.expect.batch.members[0].unitCommit`, e.unitCommit, members[0]?.unitCommit);
      if (chain.length !== members.length - 1) throw new SchemaError(`${path}.expect.batch.chain`, `${members.length - 1} merges (one per member after the first)`, chain.length);
      chain.forEach((c, i) => {
        if (c.parents[1] !== members[i + 1]?.unitCommit) throw new SchemaError(`${path}.expect.batch.chain[${i}].parents[1]`, String(members[i + 1]?.unitCommit), c.parents[1]);
        if (i > 0 && c.parents[0] !== chain[i - 1]?.commit) throw new SchemaError(`${path}.expect.batch.chain[${i}].parents[0]`, String(chain[i - 1]?.commit), c.parents[0]);
      });
      if (post.new !== chain.at(-1)?.commit) throw new SchemaError(`${path}.post.new`, `the last merge ${chain.at(-1)?.commit}`, post.new);
    },
  },
  'integration.ff': {
    expect: (value, path) => {
      const subject = typeof value === 'object' && value !== null && Object.hasOwn(value, 'subject');
      return object((f): IntegrationFfExpect => {
        const base = { ref: f.get('ref', refR), old: f.get('old', shaR), new: f.get('new', shaR) };
        return subject ? { ...base, subject: f.get('subject', ffSubject) } : { ...base, fingerprint: f.get('fingerprint', approvalFingerprint) };
      })(value, path);
    },
    post: nothing,
    outcome: tagged('kind', {
      published: kindOnly('published'),
      unpublished: object((f): OpOutcome['integration.ff'] => ({ kind: f.get('kind', literal('unpublished')), tip: f.get('tip', shaR) })),
      'recovery-required': object((f): OpOutcome['integration.ff'] => ({ kind: f.get('kind', literal('recovery-required')), observed: f.get('observed', nullable(shaR)) })),
    }),
  },
  'snapshot.publish': {
    expect: object((f) => ({
      ref: f.get('ref', refR),
      old: f.get('old', nullable(shaR)),
      highWater: f.get('highWater', positive),
      manifestSha256: f.get('manifestSha256', sha256R),
      commit: f.get('commit', commitInputs<readonly [] | readonly [Sha]>([0, 1])),
    })),
    post: object((f) => ({ new: f.get('new', shaR) })),
    outcome: kindOnly('published'),
    check: (e, _post, path) => {
      if (!/^refs\/roadmap\/[^/]+$/.test(e.ref)) throw new SchemaError(`${path}.expect.ref`, 'refs/roadmap/<arc>', e.ref);
      sameList(e.commit.parents, e.old === null ? [] : [e.old], `${path}.expect.commit.parents`);
    },
  },
  'needsuser.raise': {
    expect: object((f) => ({ id: f.get('id', (v, p): NeedsUserId => needsUserId(v, p)), path: f.get('path', absR), blocking: f.get('blocking', bool) })),
    post: object((f) => ({ sha256: f.get('sha256', sha256R) })),
    outcome: kindOnly('raised'),
  },
  'command.apply': {
    expect: object((f) => ({ command: f.get('command', cmdR), commandSha256: f.get('commandSha256', sha256R) })),
    post: nothing,
    outcome: tagged('kind', {
      applied: object((f): OpOutcome['command.apply'] => ({ kind: f.get('kind', literal('applied')), receiptSha256: f.get('receiptSha256', sha256R) })),
      rejected: object((f): OpOutcome['command.apply'] => ({ kind: f.get('kind', literal('rejected')), reason: f.get('reason', str) })),
    }),
  },
  'docs.commit': {
    expect: object((f) => ({
      ref: f.get('ref', refR),
      old: f.get('old', nullable(shaR)),
      pub: f.get('pub', docsJobR),
      integrationTip: f.get('integrationTip', shaR),
      worktree: f.get('worktree', absR),
      commit: f.get('commit', commitInputs<readonly [Sha]>([1])),
    })),
    post: object((f) => ({ new: f.get('new', shaR) })),
    outcome: kindOnly('committed'),
    check: (e, _post, path) => {
      if (!e.ref.endsWith(`/docs/${e.pub}`) || !/^refs\/roadmap-run\/[^/]+\/docs\/[^/]+$/.test(e.ref)) throw new SchemaError(`${path}.expect.ref`, `refs/roadmap-run/<arc>/docs/${e.pub}`, e.ref);
      sameList(e.commit.parents, [e.integrationTip], `${path}.expect.commit.parents`);
    },
  },
  'mutant.apply': {
    expect: object((f) => ({ worktree: f.get('worktree', absR), at: f.get('at', shaR), finding: f.get('finding', findingR), patchSha256: f.get('patchSha256', sha256R) })),
    post: nothing,
    outcome: tagged('kind', {
      applied: object((f): OpOutcome['mutant.apply'] => ({ kind: f.get('kind', literal('applied')), tree: f.get('tree', shaR) })),
      inapplicable: object((f): OpOutcome['mutant.apply'] => ({ kind: f.get('kind', literal('inapplicable')), detail: f.get('detail', str) })),
    }),
  },
  'revision.commit': {
    expect: object((f) => ({
      source: f.get('source', revisionSource), base: f.get('base', revisionBaseR), rev: f.get('rev', planRevR), payloadSha256: f.get('payloadSha256', sha256R),
      docs: f.get('docs', bool),
    })),
    post: nothing,
    outcome: kindOnly('applied'),
    check: (e, _post, path) => {
      if (e.rev !== e.base + 1) throw new SchemaError(`${path}.expect.rev`, String(e.base + 1), e.rev);
    },
  },
};

const batchCandidate: Read<BatchCandidate> = object((f) => {
  const out = {
    job: f.get('job', batchJobR),
    members: f.get('members', arrayOf(object((g) => ({ unit: g.get('unit', unitR), unitCommit: g.get('unitCommit', shaR), fingerprint: g.get('fingerprint', approvalFingerprint) })))),
    chain: f.get('chain', arrayOf(object((g) => {
      const parents = g.get('parents', arrayOf(shaR));
      if (parents.length !== 2) throw new SchemaError(`${g.path}.parents`, '2 parents', parents);
      return { commit: g.get('commit', shaR), parents: parents as unknown as readonly [Sha, Sha] };
    }))),
  };
  if (out.members.length < 2) throw new SchemaError(`${f.path}.members`, 'at least two members (one unit is not a batch)', out.members);
  assertUniqueUnits(out.members.map((m) => m.unit), `${f.path}.members`);
  return out;
});

function assertUniqueUnits(units: readonly UnitId[], path: string): void {
  if (new Set(units).size !== units.length) throw new SchemaError(path, 'each unit once', units);
}

const ffSubject: Read<FfSubject> = tagged('type', {
  docs: object((f): FfSubject => ({ type: f.get('type', literal('docs')), pub: f.get('pub', docsJobR) })),
  batch: object((f): FfSubject => ({ type: f.get('type', literal('batch')), job: f.get('job', batchJobR) })),
});

const parent: Read<Parent> = tagged('type', {
  stage: object((f): Parent => ({ type: f.get('type', literal('stage')), unit: f.get('unit', unitR), stage: f.get('stage', stage), attempt: f.get('attempt', positive) })),
  command: object((f): Parent => ({ type: f.get('type', literal('command')), command: f.get('command', cmdR) })),
  op: object((f): Parent => ({ type: f.get('type', literal('op')), op: f.get('op', opR) })),
  arc: object((f): Parent => ({ type: f.get('type', literal('arc')) })),
  job: object((f): Parent => ({ type: f.get('type', literal('job')), job: f.get('job', jobR) })),
});

const meterSubject: Read<MeterSubject> = tagged('type', {
  seat: object((f): MeterSubject => ({
    type: f.get('type', literal('seat')), ...unitSeatFields(f), unit: f.get('unit', unitR), attempt: f.get('attempt', positive),
  })),
  smoke: object((f): MeterSubject => ({ type: f.get('type', literal('smoke')), backend: f.get('backend', backend) })),
  job: object((f): MeterSubject => ({ type: f.get('type', literal('job')), ...arcSeatFields(f), job: f.get('job', jobR), attempt: f.get('attempt', positive) })),
});

const planChange: Read<PlanChange> = tagged('type', {
  'unit-added': object((f): PlanChange => ({ type: f.get('type', literal('unit-added')), unit: f.get('unit', unitR) })),
  'unit-removed': object((f): PlanChange => ({ type: f.get('type', literal('unit-removed')), unit: f.get('unit', unitR) })),
  'unit-changed': object((f): PlanChange => ({ type: f.get('type', literal('unit-changed')), unit: f.get('unit', unitR) })),
  order: object((f): PlanChange => ({ type: f.get('type', literal('order')) })),
  spec: object((f): PlanChange => ({
    type: f.get('type', literal('spec')), unit: f.get('unit', unitR), edit: f.get('edit', oneOf(SPEC_EDITS)), specRev: f.get('specRev', specRevR),
    specSha256: f.get('specSha256', sha256R),
  })),
  routing: object((f): PlanChange => {
    const unit = f.optional('unit', unitR);
    return { type: f.get('type', literal('routing')), routingRev: f.get('routingRev', revR), ...(unit === undefined ? {} : { unit }) };
  }),
  resource: object((f): PlanChange => ({
    type: f.get('type', literal('resource')), resource: f.get('resource', resR), edit: f.get('edit', oneOf(['added', 'changed', 'removed'] as const)),
  })),
  suite: object((f): PlanChange => ({ type: f.get('type', literal('suite')) })),
  'plan-field': object((f): PlanChange => ({ type: f.get('type', literal('plan-field')), field: f.get('field', oneOf(PLAN_FIELDS)) })),
  'unit-cut': object((f): PlanChange => ({ type: f.get('type', literal('unit-cut')), unit: f.get('unit', unitR) })),
  'unit-reentered': object((f): PlanChange => {
    const out = { type: f.get('type', literal('unit-reentered')), unit: f.get('unit', unitR), reenters: f.get('reenters', unitR), reset: f.get('reset', bool) };
    if (out.reenters === out.unit) throw new SchemaError(`${f.path}.reenters`, 'a unit other than the re-entering one', out.reenters);
    return out;
  }),
  obligation: object((f): PlanChange => ({ type: f.get('type', literal('obligation')), id: f.get('id', obligationR), edit: f.get('edit', oneOf(OBLIGATION_EDITS)) })),
  mapping: object((f): PlanChange => ({ type: f.get('type', literal('mapping')) })),
  vision: object((f): PlanChange => ({ type: f.get('type', literal('vision')), rev: f.get('rev', positive) })),
  limits: object((f): PlanChange => ({ type: f.get('type', literal('limits')), unit: f.get('unit', nullable(unitR)) })),
  holistic: object((f): PlanChange => ({ type: f.get('type', literal('holistic')) })),
});

export const revisionPayload: Read<RevisionPayload> = object((f) => {
  const out: RevisionPayload = {
    v: f.get('v', version),
    source: f.get('source', revisionSource),
    base: f.get('base', revisionBaseR),
    rev: f.get('rev', planRevR),
    manifest: f.get('manifest', object((g) => ({ planSha256: g.get('planSha256', sha256R), specs: g.get('specs', manifestSpecs), ...revisionInputs(g) }))),
    changes: f.get('changes', arrayOf(planChange)),
    dispositions: f.get('dispositions', arrayOf(object((g) => ({
      obligation: g.get('obligation', obligationR), disposition: g.get('disposition', oneOf(OBLIGATION_DISPOSITIONS)), ruling: g.get('ruling', (v, p): RulingId => rulingId(v, p)),
    })))),
    divergences: f.get('divergences', arrayOf(divergenceDraft)),
    publication: f.get('publication', nullable(object((g) => ({
      renders: g.get('renders', sortedBy(object((h) => ({ path: h.get('path', (v, p) => repoPath(v, p)), sha256: h.get('sha256', sha256R) })), (r) => r.path)),
      contractOps: g.get('contractOps', arrayOf(contractOp)),
    })))),
    routingProvenance: f.get('routingProvenance', routingProvenance),
  };
  if (out.rev !== out.base + 1) throw new SchemaError(`${f.path}.rev`, String(out.base + 1), out.rev);
  return out;
});

export function parseRevisionPayload(value: unknown): RevisionPayload {
  return revisionPayload(value, 'revision');
}

const probeTarget: Read<ProbeTarget> = tagged('type', {
  backend: object((f): ProbeTarget => ({ type: f.get('type', literal('backend')), backend: f.get('backend', backend) })),
  host: object((f): ProbeTarget => ({ type: f.get('type', literal('host')) })),
  resource: object((f): ProbeTarget => ({ type: f.get('type', literal('resource')), instance: f.get('instance', instR) })),
});

const parkRecord: Read<ParkRecord> = tagged('class', {
  retryable: object((f): ParkRecord => ({
    class: f.get('class', literal('retryable')), targets: f.get('targets', sortedBy(probeTarget, probeTargetKey, { nonEmpty: true })),
  })),
  operator: object((f): ParkRecord => ({ class: f.get('class', literal('operator')), kind: f.get('kind', oneOf(OPERATOR_PARK_KINDS)) })),
});

const holdCause: Read<HoldCause> = object((f) => ({
  type: f.get('type', literal('backend')), backend: f.get('backend', backend), parkSeq: f.get('parkSeq', positive),
}));

/** Strictly ascending seqs, non-empty. */
const seqSet: Read<readonly number[]> = (value, path) => {
  const list = arrayOf(positive, { nonEmpty: true })(value, path);
  for (let i = 1; i < list.length; i++) if (!((list[i - 1] as number) < (list[i] as number))) throw new SchemaError(`${path}[${i}]`, 'ascending seqs, no duplicates', value);
  return list;
};

const witnessFor: Read<WitnessFor> = tagged('type', {
  candidate: object((f): WitnessFor => ({ type: f.get('type', literal('candidate')), unit: f.get('unit', unitR), attempt: f.get('attempt', positive) })),
  job: object((f): WitnessFor => ({ type: f.get('type', literal('job')), job: f.get('job', jobR) })),
  mutant: object((f): WitnessFor => ({ type: f.get('type', literal('mutant')), finding: f.get('finding', findingR), of: f.get('of', shaR) })),
});
const lensR = oneOf(LENS_KIND_NAMES);
const lensSet: Read<readonly LensKindName[]> = sortedBy(lensR, (l) => l, { nonEmpty: true });
const findingSet: Read<readonly FindingId[]> = sortedBy(findingR, (id) => id);
const auditJobR: Read<JobId> = (v, p) => jobIdOfKind('audit')(v, p);
const ckptJobR: Read<JobId> = (v, p) => jobIdOfKind('ckpt')(v, p);

const bundleOutcome: Read<BundleOutcome> = tagged('kind', {
  'no-op': object((f): BundleOutcome => ({ kind: f.get('kind', literal('no-op')) })),
  rejected: object((f): BundleOutcome => ({ kind: f.get('kind', literal('rejected')), reason: f.get('reason', oneOf(['stale', 'evidence', 'invalid'] as const)), detail: f.get('detail', str) })),
  requested: object((f): BundleOutcome => ({ kind: f.get('kind', literal('requested')), needsUser: f.get('needsUser', (v, p) => needsUserId(v, p)) })),
});

/** The readers of the M3 facts, spread into `fact`. */
const HOLISTIC_FACT_READERS: { readonly [K in HolisticFactKind]: Read<Fact> } = {
  witnessed: object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('witnessed')), lane: f.get('lane', laneR), laneRev: f.get('laneRev', laneRevR), envId: f.get('envId', (v, p): EnvId => envId(v, p)),
      treeSha: f.get('treeSha', shaR), inv: f.get('inv', invR), recordsSha256: f.get('recordsSha256', sha256R), purpose: f.get('purpose', oneOf(WITNESS_PURPOSES)),
      for: f.get('for', witnessFor),
    };
    // G13: a mutant run is recorded as such and never certifies.
    if ((out.purpose === 'mutant') !== (out.for.type === 'mutant')) throw new SchemaError(`${f.path}.for`, out.purpose === 'mutant' ? 'mutant{finding, of}' : 'a candidate or a job', out.for);
    return out;
  }),
  'obligation-latched': object((f): Fact => ({
    kind: f.get('kind', literal('obligation-latched')), obligation: f.get('obligation', obligationR), unit: f.get('unit', unitR), treeSha: f.get('treeSha', shaR),
  })),
  'finding-opened': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('finding-opened')), id: f.get('id', findingR), key: f.get('key', sha256R), lens: f.get('lens', oneOf(FINDING_LENSES)),
      severity: f.get('severity', oneOf(FINDING_SEVERITIES)), obligation: f.get('obligation', nullable(obligationR)),
      visionClauses: f.get('visionClauses', sortedBy((v, p): VisionClauseId => visionClauseId(v, p), (c) => c)), claim: f.get('claim', str),
      evidence: f.get('evidence', arrayOf(findingEvidence)), mutant: f.get('mutant', nullable(mutantRef)), source: f.get('source', findingSource),
      gateHadPassed: f.get('gateHadPassed', bool),
    };
    if (out.mutant !== null && out.lens !== 'vacuity') throw new SchemaError(`${f.path}.mutant`, 'null except for a vacuity finding', out.mutant);
    // R17: plan-check opens only P3 vision-conflict findings, from its own attempt; every other opener is a job.
    if ((out.lens === 'plan-check') !== (out.source.type === 'stage')) throw new SchemaError(`${f.path}.source`, out.lens === 'plan-check' ? 'the plan-check attempt' : 'the job that opened it', out.source);
    if (out.lens === 'plan-check' && (out.severity !== 'P3' || out.visionClauses.length === 0)) throw new SchemaError(`${f.path}.severity`, 'P3 citing vision clauses for a plan-check vision conflict', out.severity);
    // A must-hold not held on an audit snapshot opens a P1 over its obligation.
    if (out.lens === 'witness' && (out.severity !== 'P1' || out.obligation === null)) throw new SchemaError(`${f.path}.severity`, 'P1 over its obligation for a witness finding', out.severity);
    if (out.lens === 'vision' && out.severity === 'P1') throw new SchemaError(`${f.path}.severity`, 'P2 or P3 for a vision-lens finding', out.severity);
    return out;
  }),
  'finding-transition': object((f): Fact => ({ kind: f.get('kind', literal('finding-transition')), id: f.get('id', findingR), to: f.get('to', findingTo) })),
  'audit-started': object((f): Fact => ({
    kind: f.get('kind', literal('audit-started')),
    job: f.get('job', auditJobR),
    triggers: f.get('triggers', arrayOf(auditTrigger, { nonEmpty: true })),
    generation: f.get('generation', positive),
    lenses: f.get('lenses', lensSet),
    integrationSha: f.get('integrationSha', shaR),
    planRev: f.get('planRev', planRevR),
    ledgerSha256: f.get('ledgerSha256', nullable(sha256R)),
    obligationsSha256: f.get('obligationsSha256', nullable(sha256R)),
    visionSha256: f.get('visionSha256', sha256R),
    owners: f.get('owners', sortedBy(object((g) => ({ unit: g.get('unit', unitR), head: g.get('head', shaR) })), (o) => o.unit)),
    priorFindings: f.get('priorFindings', findingSet),
    highWater: f.get('highWater', positive),
  })),
  'audit-ended': object((f): Fact => ({
    kind: f.get('kind', literal('audit-ended')),
    job: f.get('job', auditJobR),
    covered: f.get('covered', sortedBy(object((g) => ({ lens: g.get('lens', lensR), from: g.get('from', shaR), to: g.get('to', shaR) })), (c) => c.lens)),
    findings: f.get('findings', findingSet),
    suppressed: f.get('suppressed', nat),
    outcome: f.get('outcome', oneOf(['completed', 'abandoned'] as const)),
  })),
  'docs-covered': object((f): Fact => ({ kind: f.get('kind', literal('docs-covered')), pub: f.get('pub', docsJobR), from: f.get('from', shaR), to: f.get('to', shaR) })),
  'checkpoint-inputs': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('checkpoint-inputs')), job: f.get('job', ckptJobR), trigger: f.get('trigger', checkpointTrigger),
      generation: f.get('generation', positive), vector: f.get('vector', revisionVector), headSha: f.get('headSha', shaR), visionSha256: f.get('visionSha256', sha256R),
      findings: f.get('findings', findingSet),
      observations: f.get('observations', sortedBy(observationKey, (k: ObservationKey) => `${k.treeSha}/${k.lane}/${k.laneRev}/${k.envId}`)),
    };
    if (out.vector.visionSha256 !== out.visionSha256) throw new SchemaError(`${f.path}.vector.visionSha256`, out.visionSha256, out.vector.visionSha256);
    return out;
  }),
  'bundle-decided': object((f): Fact => ({ kind: f.get('kind', literal('bundle-decided')), job: f.get('job', ckptJobR), outcome: f.get('outcome', bundleOutcome) })),
  divergence: object((f): Fact => ({ kind: f.get('kind', literal('divergence')), id: f.get('id', (v, p): DivergenceId => divergenceId(v, p)), index: f.get('index', nat), ...divergenceDraftFields(f) })),
  'divergence-digest': object((f): Fact => ({
    kind: f.get('kind', literal('divergence-digest')), needsUser: f.get('needsUser', (v, p): NeedsUserId => needsUserId(v, p)),
    ids: f.get('ids', sortedBy((v, p): DivergenceId => divergenceId(v, p), (d) => d, { nonEmpty: true })),
  })),
  steered: object((f): Fact => ({
    kind: f.get('kind', literal('steered')), unit: f.get('unit', unitR), command: f.get('command', cmdR), brief: f.get('brief', sha256R),
    budgetMin: f.get('budgetMin', positive), resume: f.get('resume', bool),
  })),
  'merged-in': object((f): Fact => ({
    kind: f.get('kind', literal('merged-in')), unit: f.get('unit', unitR), command: f.get('command', cmdR), integrationTip: f.get('integrationTip', shaR), head: f.get('head', shaR),
  })),
  'audit-requested': object((f): Fact => ({ kind: f.get('kind', literal('audit-requested')), command: f.get('command', cmdR), lenses: f.get('lenses', nullable(lensSet)) })),
  'admissions-closed': object((f): Fact => ({ kind: f.get('kind', literal('admissions-closed')), command: f.get('command', cmdR) })),
  'docs-published': object((f): Fact => ({ kind: f.get('kind', literal('docs-published')), pub: f.get('pub', docsJobR), source: f.get('source', literal('close-out')), commit: f.get('commit', shaR) })),
  'arc-completed': object((f): Fact => ({
    kind: f.get('kind', literal('arc-completed')), planRev: f.get('planRev', planRevR), head: f.get('head', shaR), highWater: f.get('highWater', positive),
    units: f.get('units', sortedBy(unitR, (u) => u)),
  })),
};

export const fact: Read<Fact> = tagged('kind', {
  'tail-discarded': object((f): Fact => ({ kind: f.get('kind', literal('tail-discarded')), offset: f.get('offset', nat), length: f.get('length', positive), sha256: f.get('sha256', sha256R) })),
  'containment-mode': object((f): Fact => ({ kind: f.get('kind', literal('containment-mode')), mode: f.get('mode', containmentMode) })),
  meter: object((f): Fact => ({
    kind: f.get('kind', literal('meter')), inv: f.get('inv', invR), routingRev: f.get('routingRev', revR), subject: f.get('subject', meterSubject),
    usage: f.get('usage', tokenUsage),
  })),
  'usage-unavailable': object((f): Fact => ({
    kind: f.get('kind', literal('usage-unavailable')), inv: f.get('inv', invR), routingRev: f.get('routingRev', revR), subject: f.get('subject', meterSubject),
    reason: f.get('reason', usageUnavailableReason),
  })),
  dispatch: object((f): Fact => ({ kind: f.get('kind', literal('dispatch')), record: f.get('record', dispatchRecord) })),
  'backend-park': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('backend-park')), backend: f.get('backend', backend), class: f.get('class', oneOf(BACKEND_PARK_CLASSES)),
      inv: f.get('inv', nullable(invR)),
    };
    // A failed call names its invocation; a respawn smoke's outage names none.
    if ((out.class === 'outage') !== (out.inv === null)) throw new SchemaError(`${f.path}.inv`, out.class === 'outage' ? 'null for an outage' : 'the failed invocation', out.inv);
    return out;
  }),
  'needs-user-acked': object((f): Fact => ({
    kind: f.get('kind', literal('needs-user-acked')), id: f.get('id', (v, p): NeedsUserId => needsUserId(v, p)), command: f.get('command', cmdR),
    choice: f.get('choice', nullable(optionId)),
  })),
  paused: object((f): Fact => ({ kind: f.get('kind', literal('paused')), command: f.get('command', cmdR), target: f.get('target', pauseTarget) })),
  'stop-requested': object((f): Fact => ({ kind: f.get('kind', literal('stop-requested')), command: f.get('command', cmdR) })),
  resumed: object((f): Fact => ({ kind: f.get('kind', literal('resumed')), command: f.get('command', cmdR), target: f.get('target', resumeTarget) })),
  reopened: object((f): Fact => ({
    kind: f.get('kind', literal('reopened')), unit: f.get('unit', unitR), command: f.get('command', nullable(cmdR)), specRev: f.get('specRev', specRevR),
    specSha256: f.get('specSha256', sha256R),
  })),
  rerouted: object((f): Fact => ({ kind: f.get('kind', literal('rerouted')), unit: f.get('unit', unitR), command: f.get('command', cmdR) })),
  unparked: object((f): Fact => ({ kind: f.get('kind', literal('unparked')), unit: f.get('unit', unitR), command: f.get('command', cmdR) })),
  probe: object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('probe')), target: f.get('target', probeTarget), covers: f.get('covers', seqSet),
      result: f.get('result', oneOf(['pass', 'fail'] as const)), nextProbeAt: f.get('nextProbeAt', nullable((v, p): IsoTime => isoTime(v, p))),
    };
    if ((out.result === 'pass') !== (out.nextProbeAt === null)) throw new SchemaError(`${f.path}.nextProbeAt`, out.result === 'pass' ? 'null on a pass' : 'the next probe time on a fail', out.nextProbeAt);
    return out;
  }),
  'judgment-inputs': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('judgment-inputs')), unit: f.get('unit', unitR), stage: f.get('stage', oneOf(JUDGMENT_STAGES)), attempt: f.get('attempt', positive),
      tip: f.get('tip', shaR), head: f.get('head', nullable(shaR)), specRev: f.get('specRev', specRevR), specSha256: f.get('specSha256', sha256R),
      planRev: f.get('planRev', (v, p) => planRev(v, p)), routingRev: f.get('routingRev', revR),
    };
    if ((out.stage === 'gate') !== (out.head !== null)) throw new SchemaError(`${f.path}.head`, out.stage === 'gate' ? 'the unit commit the gate read' : 'null for a plan-check', out.head);
    const fingerprint = f.optional('fingerprint', approvalFingerprint);
    if (fingerprint === undefined) return out;
    if (out.stage !== 'gate') throw new SchemaError(`${f.path}.fingerprint`, 'absent on a plan-check', fingerprint);
    if (fingerprint.unitCommit !== out.head) throw new SchemaError(`${f.path}.fingerprint.unitCommit`, `the head the gate read (${out.head})`, fingerprint.unitCommit);
    return { ...out, fingerprint };
  }),
  'edge-resolved': object((f): Fact => ({
    kind: f.get('kind', literal('edge-resolved')), edge: f.get('edge', (v, p) => edgeId(v, p)), command: f.get('command', cmdR), evidence: f.get('evidence', str),
  })),
  'run-only': object((f): Fact => ({
    kind: f.get('kind', literal('run-only')), command: f.get('command', cmdR), units: f.get('units', nullable(sortedBy(unitR, (u) => u, { nonEmpty: true }))),
  })),
  'implementer-escalated': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('implementer-escalated')), unit: f.get('unit', unitR), attempt: f.get('attempt', positive), from: f.get('from', riskTier),
      to: f.get('to', literal('high')), stalled: f.get('stalled', positive),
    };
    if (out.from === 'high') throw new SchemaError(`${f.path}.from`, 'a build tier below high', out.from);
    if (!(out.stalled < out.attempt)) throw new SchemaError(`${f.path}.stalled`, `a build attempt before ${out.attempt}`, out.stalled);
    return out;
  }),
  'plan-applied': object((f): Fact => {
    const scheduling = f.optional('scheduling', literal('dag'));
    const m3: Record<string, unknown> = {};
    const opt = <T>(key: keyof PlanAppliedM3, read: Read<T>): void => {
      const v = f.optional(key, read);
      if (v !== undefined) m3[key] = v;
    };
    opt('source', revisionSource);
    opt('payloadSha256', sha256R);
    opt('rulingsSha256', sha256R);
    opt('obligationsSha256', sha256R);
    opt('visionSha256', sha256R);
    opt('publication', object((g) => ({ pub: g.get('pub', docsJobR), head: g.get('head', shaR) })));
    opt('routingProvenance', routingProvenance);
    const out = {
      kind: f.get('kind', literal('plan-applied')), rev: f.get('rev', (v, p) => planRev(v, p)), command: f.get('command', nullable(cmdR)),
      planSha256: f.get('planSha256', sha256R), specs: f.get('specs', manifestSpecs), changes: f.get('changes', arrayOf(planChange)),
      ...(scheduling === undefined ? {} : { scheduling }), ...(m3 as PlanAppliedM3),
    };
    if (scheduling !== undefined && out.rev !== 1) throw new SchemaError(`${f.path}.scheduling`, 'absent after rev 1 (the arc\'s scheduling is fixed at its first plan)', scheduling);
    const source = m3['source'] as RevisionSource | undefined;
    if (source !== undefined && (source.type === 'command' ? source.command !== out.command : out.command !== null)) {
      throw new SchemaError(`${f.path}.source`, `the source naming command ${out.command}`, source);
    }
    if (m3['obligationsSha256'] !== undefined && m3['visionSha256'] === undefined) throw new SchemaError(`${f.path}.obligationsSha256`, 'absent without a vision (obligations are a holistic input, A5)', m3['obligationsSha256']);
    return out;
  }),
  'executor-started': object((f): Fact => ({ kind: f.get('kind', literal('executor-started')), generation: f.get('generation', positive) })),
  approval: object((f): Fact => ({
    kind: f.get('kind', literal('approval')), unit: f.get('unit', unitR), attempt: f.get('attempt', positive), fingerprint: f.get('fingerprint', approvalFingerprint),
  })),
  ...HOLISTIC_FACT_READERS,
  'stage-outcome': object((f): Fact => {
    const s = f.get('stage', oneOf(OUTCOME_STAGES));
    const out = {
      kind: f.get('kind', literal('stage-outcome')),
      unit: f.get('unit', unitR),
      stage: s,
      attempt: f.get('attempt', positive),
      outcome: f.get('outcome', oneOf(STAGE_OUTCOME_KINDS[s])),
      class: f.get('class', oneOf(OUTCOME_CLASSES)),
      chargeable: f.get('chargeable', bool),
    } as StageOutcomeFact;
    const park = f.optional('park', parkRecord);
    const cause = f.optional('cause', holdCause);
    if (park !== undefined && out.class !== 'park') throw new SchemaError(`${f.path}.park`, 'absent unless the class is park', park);
    if (cause !== undefined && out.class !== 'hold') throw new SchemaError(`${f.path}.cause`, 'absent unless the class is hold', cause);
    // The chargeable bound is a design park: the unit needs a spec revision or a re-entry.
    if (park !== undefined && out.chargeable && !(park.class === 'operator' && park.kind === 'design')) throw new SchemaError(`${f.path}.park`, 'operator design for the chargeable bound', park);
    // The fold keys retries and route-ups by stage, so those classes only exist where the stage has them.
    if (out.class === 'retry' && !(RETRY_STAGES as readonly string[]).includes(s)) throw new SchemaError(`${f.path}.class`, `retry only at ${RETRY_STAGES.join(', ')}`, out.class);
    if (out.class === 'route-up' && !(JUDGMENT_STAGES as readonly string[]).includes(s)) throw new SchemaError(`${f.path}.class`, `route-up only at ${JUDGMENT_STAGES.join(', ')}`, out.class);
    // An interruption holds the unit, and nothing else does; a hold never charges.
    if ((out.outcome === 'interrupted') !== (out.class === 'hold')) throw new SchemaError(`${f.path}.class`, 'hold exactly for an interrupted outcome', out.class);
    if (out.class === 'hold' && out.chargeable) throw new SchemaError(`${f.path}.chargeable`, 'false for a hold', out.chargeable);
    return { ...out, ...(park === undefined ? {} : { park }), ...(cause === undefined ? {} : { cause }) } as StageOutcomeFact;
  }),
});

function intentRecord(f: Fields): IntentRecord {
  const kind = f.get('kind', oneOf(OP_KINDS));
  const schema = OP_SCHEMAS[kind] as OpSchema<OpKind>;
  const out = {
    type: 'intent' as const,
    op: f.get('op', opR),
    kind,
    key: f.get('key', (v, p): OpKey => opKey(v, p)),
    parent: f.get('parent', parent),
    ordinal: f.get('ordinal', positive),
    deadlineAt: f.get('deadlineAt', nullable((v, p): IsoTime => isoTime(v, p))),
    expect: f.get('expect', schema.expect),
    post: f.get('post', schema.post),
  };
  schema.check?.(out.expect, out.post, f.path);
  return out as IntentRecord;
}

function doneRecord(f: Fields): DoneRecord {
  const kind = f.get('kind', oneOf(OP_KINDS));
  return {
    type: 'done',
    op: f.get('op', opR),
    kind,
    outcome: f.get('outcome', (OP_SCHEMAS[kind] as OpSchema<OpKind>).outcome),
    recoveredBy: f.get('recoveredBy', nullable(oneOf(['reconciled', 'redone', 'adopted'] as const))),
  } as DoneRecord;
}

function abortRecord(f: Fields): AbortRecord {
  return {
    type: 'abort',
    op: f.get('op', opR),
    reason: f.get('reason', object((g) => ({ code: g.get('code', oneOf(['precondition', 'recovery', 'cancelled'] as const)), detail: g.get('detail', str) }))),
  };
}

const RECORD_READERS: { readonly [T in LogRecord['type']]: (f: Fields) => LogRecord } = {
  intent: intentRecord,
  done: doneRecord,
  abort: abortRecord,
  fact: (f) => ({ type: 'fact', fact: f.get('fact', fact) }),
};

// ---------------------------------------------------------------------------------------------------
// Lines: canonical JSON + '\n', chained by sha256 of the previous line's exact bytes.

export type ChainEnvelope = Readonly<{ v: SchemaVersion; seq: number; prev: Sha256Hex | null; at: IsoTime }>;
/** One line of the host's residues.jsonl. */
export type ResidueLine = ChainEnvelope & ResidueRecord;

function chainEnvelope(f: Fields): ChainEnvelope {
  const env = { v: f.get('v', version), seq: f.get('seq', positive), prev: f.get('prev', nullable(sha256R)), at: f.get('at', (v, p): IsoTime => isoTime(v, p)) };
  if ((env.seq === 1) !== (env.prev === null)) throw new SchemaError(`${f.path}.prev`, env.seq === 1 ? 'null on seq 1' : 'a sha256 after seq 1', env.prev);
  return env;
}

function jsonLine(line: string, what: string): unknown {
  if (line.includes('\n')) throw new SchemaError(what, 'one line without its terminating newline', line);
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new SchemaError(what, `JSON (${(err as Error).message})`, line);
  }
}

function assertCanonical(parsed: unknown, line: string, what: string): void {
  if (canonicalJson(parsed) !== line) throw new SchemaError(what, 'canonical JSON (sorted keys, no whitespace, known fields only)', line);
}

/** Parses one complete log line, given without its trailing `\n`. Throws on anything but a canonical, valid event. */
export function parseEventLine(line: string): Event {
  const raw = jsonLine(line, 'event');
  const f = new Fields(raw, 'event');
  const env = { ...chainEnvelope(f), arc: f.get('arc', (v, p): ArcId => arcId(v, p)) };
  const type = f.get('type', oneOf(['intent', 'done', 'abort', 'fact'] as const));
  const record = RECORD_READERS[type](f);
  f.end();
  if (record.type === 'intent' || record.type === 'done' || record.type === 'abort') {
    if (parseOpId(record.op).arc !== env.arc) throw new SchemaError('event.op', `an op of arc ${env.arc}`, record.op);
  }
  const event = { ...env, ...record } as Event;
  assertCanonical(event, line, 'event');
  return event;
}

export function serializeEvent(event: Event): string {
  return `${canonicalJson(event)}\n`;
}

/** Parses one complete residues.jsonl line (same chain rules, no `arc` in the envelope). */
export function parseChainLine<T extends object>(line: string, body: Read<T>, what: string): ChainEnvelope & T {
  const raw = jsonLine(line, what);
  const env = chainEnvelope(new Fields(raw, what));
  const { v: _v, seq: _s, prev: _p, at: _a, ...rest } = raw as Record<string, unknown>;
  const out = { ...env, ...body(rest, what) };
  assertCanonical(out, line, what);
  return out;
}

export function serializeChainLine<T extends object>(line: ChainEnvelope & T): string {
  return `${canonicalJson(line)}\n`;
}

/** The `prev` of the next line: sha256 over the previous line's exact bytes, including its `\n`. */
export function prevHash(lineBytes: Buffer): Sha256Hex {
  if (lineBytes.length === 0 || lineBytes[lineBytes.length - 1] !== 0x0a) {
    throw new Error('prevHash: a complete line ends with \\n; refusing to hash a torn line');
  }
  return sha256(sha256Hex(lineBytes));
}
