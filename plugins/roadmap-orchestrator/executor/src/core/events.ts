// The event log (`events.jsonl`) record types, their validators, canonical serialisation and the chain
// hash rule. The journal (append, tail, fold) is step 2 and builds on these. SCHEMAS.md "Event log" is the
// prose twin of this module.
import type { Buffer } from 'node:buffer';
import {
  type AmendmentId, type ArcId, type CommandId, type DebtId, type DivergenceId, type EdgeId, type EnvId, type FindingId, type InvocationId,
  type IssueId, type JobId, type KnownDefectId, type LaneId, type LaneRev, type NeedsUserId, type ObligationId, type OpId, type OpKey, type OpportunityId, type PlanRev,
  knownDefectId, opportunityId,
  type ResourceInstance, type ResourceName, type ResourceUnit, type RoutingRev, type RuleId, type RulingId, type Sha, type Sha256Hex, type SpecRev,
  type ProposalId, type UnitId, type VisionClauseId, INTEGRATION_SLOT, proposalId, proposalJob, amendmentId, arcId, commandId, compareResourceUnits, debtId, divergenceId, edgeId, envId,
  findingId, invocationIdOf, issueId, jobIdOf, jobIdOfKind, laneId, laneRev, needsUserId, obligationId, opIdOf, opKey, parseInvocationId, parseJobId, parseOpId,
  parseResourceUnit, planRev, resourceInstance, resourceName, resourceUnit, routingRev, ruleId, rulingId, sha, sha256, specRev, unitId,
  visionClauseId, idList, type ClaudeSessionId, claudeSessionId,
  type JourneyId, type MilestoneId, type PolishId, type ServeName, journeyId, milestoneId, polishId, serveName,
} from './ids.ts';
import { type BankReason, type DebtSource, BANK_REASONS, debtSource } from '../debt/types.ts';
import {
  type FlowDropped, type FlowEndedConstraint, type FlowMetric, type FlowOutcome, type FlowPreimage, type FlowProposal, type FlowTrigger, type FlowVerdictKind,
  type GuardBreach, type HostFingerprint, type ProofMinutes, type ProofOutcome, type VerdictAfter, type VerdictBefore, FLOW_OUTCOMES, FLOW_VERDICTS,
  MIN_VERDICT_SAMPLES, PROOF_OUTCOMES, flowDropped, fraction, flowEndedConstraint, flowMetric, flowPreimage, flowProposal, flowTriggers, guardBreaches, hostFingerprint,
  proofMinutes, verdictAfter, verdictBefore,
} from '../flow/types.ts';
import { type IssueIntakeOutcome, type RepoIdentity, issueIntakeOutcome, repoIdentity } from '../forge/types.ts';
import { type PressureAvailability, PRESSURE_AVAILABILITIES } from '../host/pressure.ts';
import { canonicalJson, sha256Hex } from './json.ts';
import {
  COMMAND_VERDICTS, DEMO_ACTS, LENS_KIND_NAMES, type ApprovalFingerprint, type DemoAct, type BackendOutcomeKind, type CommandVerdict, type ContainmentMode,
  type DispatchRecord, type KillReason, type KnownDefectMatch, type LensKindName, type PauseTarget, type PlanManifest, type RedRev, type ResidueRecord, type ResumeTarget,
  type RevisionManifest, type SpecPatch, type Stage, type TokenUsage, type ClassUsage, classUsages, type UsageUnavailableReason, approvalFingerprint, containmentMode,
  dispatchRecord, killReason, knownDefectMatch, optionId, pauseTarget, manifestSpecs, resumeTarget, revisionInputs, specPatch, stage, tokenUsage,
  usageUnavailableReason,
} from './records.ts';
import {
  type BusyAttempt, type ClassifiedAdmit, type Conversion, type ConversionReason, BUNDLE_REJECTIONS, CONVERSION_REASONS, classifiedAdmit, conversion,
  type AuditTrigger, type BundleOutcome, type CheckpointTrigger, type ContractOp, type DivergenceDraft, type FindingEvidence, type FindingLens,
  type FindingSeverity, type FindingSource, type FindingTo, type MutantRef, type ObligationDisposition, type ObservationKey, type PackDisposition, type PackFinding,
  type RevisionVector, type WitnessPurpose, FINDING_LENSES, FINDING_SEVERITIES, OBLIGATION_DISPOSITIONS, WITNESS_PURPOSES, auditTrigger,
  checkpointTrigger, contractOp, divergenceDraft, divergenceDraftFields, findingEvidence, findingSource, findingTo, mutantRef, observationKey,
  packDisposition, packFinding, revisionVector, type PlanDefect, planDefect,
} from '../holistic/types.ts';
import {
  type Read, Fields, SchemaError, arrayOf, assertUnique, bool, int, literal, nat, nullable, object, oneOf, positive, sortedBy, str, tagged, text,
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
 * What a mutant was made for (M4a rev 3, D2): a vacuity finding's patch (B3), or a unit attempt's mutation smoke (the
 * attempt's production diff reverted). A 1.0.0-dev.6 record names `finding` instead, read as `of: finding`
 * (`mutantSubjectDefault`, src/core/upgrade.ts).
 */
export type MutantOf = Readonly<{ type: 'finding'; finding: FindingId }> | Readonly<{ type: 'smoke'; unit: UnitId; attempt: number }>;

/**
 * A lane execution's reuse identity (M4a rev 3, F1a, R52), stamped on a spec lane's spawn: the lane's normalised rev
 * (`laneRevOf`), its environment's id (`envIdOf`), and argv[0] resolved to a path with its content's sha256 (null when it
 * does not resolve: never reused). Absent: a 1.0.0-dev.6 execution, never reused.
 */
export type LaneIdentity = Readonly<{ laneRev: LaneRev; envId: EnvId; argv0: Readonly<{ path: AbsPath; sha256: Sha256Hex }> | null }>;

/** A mutant run's spawn subject as written since M4a rev 3. */
export type MutantSubject = Readonly<{ purpose: 'mutant'; of: MutantOf; lane: LaneId; laneRev: LaneRev; tree: Sha }>;
/** A mutant run's spawn subject as 1.0.0-dev.6 wrote it: read byte-preserving, normalised by `mutantSubjectDefault`. */
export type Dev6MutantSubject = Readonly<{ purpose: 'mutant'; finding: FindingId; lane: LaneId; laneRev: LaneRev; tree: Sha }>;

/**
 * What a spawn runs. Model ids never appear: a backend is named by role and routingRev. M3: `arc-backend` (a lens
 * or checkpoint call of a job, on an arc seat), `journey` (an arc lane), `mutant` (a finding's lane on its patched tree).
 * M4a rev 3: `redRev` on a lane or journey spawn (the red protocol it runs under, written before the run, Q20; absent: the
 * frozen 1.0.0-dev.6 table), `identity` on a spec lane's (`LaneIdentity`), and a mutant's `of` (`MutantOf`).
 */
export type SpawnSubject =
  | (Readonly<{ purpose: 'backend'; routingRev: RoutingRev; unit: UnitId; attempt: number }> & UnitSeatRef)
  | (Readonly<{ purpose: 'arc-backend'; routingRev: RoutingRev; job: JobId; attempt: number }> & ArcSeatRef)
  | Readonly<{ purpose: 'journey'; lane: LaneId; laneRev: LaneRev; at: Sha; owner: LaneOwner; redRev?: RedRev }>
  | MutantSubject
  | Dev6MutantSubject
  | Readonly<{ purpose: 'lane'; unit: UnitId; lane: LaneId; set: 'spec' | 'suite'; at: Sha; redRev?: RedRev; identity?: LaneIdentity }>
  | Readonly<{ purpose: 'teardown' | 'probe'; unit: UnitId | null; resource: ResourceInstance }>
  /**
   * M4b: one side of a suite-lane proof (RC-4): proof job `job` runs lane `lane` with its `old` or `new` argv at the
   * integration head `at`, in a clean checkout. It journals no `witnessed`; its records are kept and named only by
   * `flow-proof`.
   */
  | Readonly<{ purpose: 'proof'; job: JobId; proposal: ProposalId; lane: LaneId; side: 'old' | 'new'; at: Sha }>
  /**
   * dev.13: one command of milestone `milestone`'s bring-up (src/walk/bringup.ts), its owner the spawn's parent (a walk
   * job). `step` names it as the `walk-tools-missing` row does: `setup[i]`, `serve.<name>`, `seed[i]`. A `serve` process
   * runs until its owner stops it (`proc.kill{teardown}`); recovery cancels a live one (its owner brings the product up
   * again).
   */
  | Readonly<{ purpose: 'bring-up'; milestone: MilestoneId; step: string }>
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
  /**
   * `notRegular` (dev.16): the named paths (a checkout's dirty paths) left uncaptured as symlinks or special files
   * (src/git/evidence.ts `namedPathGlobs`); absent when none, as in every record before dev.16.
   */
  'evidence.snapshot': Readonly<{ source: AbsPath; globs: readonly RepoPattern[]; dest: AbsPath; notRegular?: readonly RepoPath[] }>;
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
  /**
   * M3 (B3): a mutant (`inputs/<patchSha256>.patch`) applied in a detached worktree at `at`: a finding's, or (M4a rev 3) a
   * unit attempt's smoke (`MutantOf`). A 1.0.0-dev.6 intent names `finding` (`MutantApplyExpect`, `mutantSubjectDefault`).
   */
  'mutant.apply': MutantApplyExpect;
  /**
   * M3 (G1, A19): a revision's kept payload (`inputs/<payloadSha256>.revision.json`), its base and the rev it writes;
   * `base` 0 for an arc's first revision (its first start records rev 1, M3 step A2).
   */
  'revision.commit': Readonly<{ source: RevisionSource; base: RevisionBase; rev: PlanRev; payloadSha256: Sha256Hex; docs: boolean }>;
};

export type MutantApplyExpect =
  | Readonly<{ worktree: AbsPath; at: Sha; of: MutantOf; patchSha256: Sha256Hex }>
  | Readonly<{ worktree: AbsPath; at: Sha; finding: FindingId; patchSha256: Sha256Hex }>;

/** The members of a repair batch candidate and the merges chaining them. */
export type BatchCandidate = Readonly<{
  job: JobId;
  members: readonly Readonly<{ unit: UnitId; unitCommit: Sha; fingerprint: ApprovalFingerprint }>[];
  chain: readonly Readonly<{ commit: Sha; parents: readonly [Sha, Sha] }>[];
}>;

/** What an `ff` publishes besides a unit (M3): a docs publication, or a repair batch (every member's fingerprint re-checked). */
export type FfSubject = Readonly<{ type: 'docs'; pub: JobId }> | Readonly<{ type: 'batch'; job: JobId }>;
/**
 * A unit's `ff` carries its approval fingerprint and no subject (the M2 shape); a docs or batch `ff`
 * carries its subject and no fingerprint.
 */
export type IntegrationFfExpect = Readonly<{ ref: RefName; old: Sha; new: Sha }> & (
  | Readonly<{ fingerprint: ApprovalFingerprint; subject?: never }>
  | Readonly<{ subject: FfSubject; fingerprint?: never }>
);

/** The revision a revision is evaluated against: the plan rev in force, or 0 before the arc's first (M3 step A2). */
export type RevisionBase = PlanRev | 0;

/**
 * Where a revision came from (G1): the arc's start, an architect command, a checkpoint bundle, the executor's own patch, or
 * (M4b) an accepted flow proposal, committed under the fence.
 * A bundle's `admits` and `conversions` (M4a rev 3, OR-A1, Q4): code's classification of its `admit` ops, persisted in
 * the decision record before any settlement and never recomputed; both present (in a corpus arc) or both absent (an
 * `architecture-doc` arc, or 1.0.0-dev.6: unclassified, never counted against a budget or a follow-up; `bundleClassesOf`).
 * dev.13: `conversions` alone (non-empty) outside a corpus arc: the admits a brake converted (src/holistic/tail.ts).
 */
export type RevisionSource =
  | Readonly<{ type: 'start' }>
  | Readonly<{ type: 'command'; command: CommandId }>
  | Readonly<{ type: 'bundle'; job: JobId; admits?: readonly ClassifiedAdmit[]; conversions?: readonly Conversion[] }>
  | Readonly<{ type: 'executor'; inv: InvocationId }>
  | Readonly<{ type: 'flow'; proposal: ProposalId }>
  /** dev.13: the code-applied polish revision of walk `job`: its applied proposals admitted as polish units (src/walk/polish.ts). */
  | Readonly<{ type: 'walk'; job: JobId }>
  /** dev.13: the cut of polish unit `unit`, which its compare judged `drop` (`polish-dropped`, src/walk/compare.ts). */
  | Readonly<{ type: 'compare'; unit: UnitId }>;

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
  /**
   * `pressure` (M4b rev 3, additive): the launch's own cpu wait (src/host/pressure.ts), read from its exit.json `cpu`
   * in every settle mode; null without schedstat, for a launch under `PRESSURE_MIN_WALL_MS`, or an exit.json an earlier
   * runner wrote. Absent on a spawn an earlier executor closed: read as null (`spawnPressureOf`).
   */
  'proc.spawn':
    | Readonly<{ kind: 'result'; resultSha256: Sha256Hex; summary: ResultSummary; pressure?: number | null }>
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
  // enters a `resolve` round (A6). `interrupted` (arc feedback 2026-10-15): only ever the recovery hold of a preparation
  // a crash cut short (`cause: recovery`); the stage itself is never cancelled.
  prepare: ['clean-plan-check', 'clean-build', 'clean-verify', 'conflicted', 'interrupted'],
  // A vacuity repair's first stage (M3, B3): the mutant applied and its lane run. `reproduced` goes on to
  // plan-check; `not-reproduced` dismisses the finding and parks; `inapplicable` parks for the next audit.
  reproduce: ['reproduced', 'not-reproduced', 'inapplicable', 'blocked', 'interrupted', 'cleanup-failed'],
  // M4a rev 3 (E) to dev.16: `in-session` (a frontier or summit builder under `planCheck.shape: by-builder`: no plan-check
  // call, the build assessed in session). dev.17 records none; read from an older log.
  // Paid M4b run 5: `read-denied`, as at the gate (no longer recorded since 2026-10-16; read from a 1.0.0-dev.11 log).
  // Scope growth (2026-10-15): `scope-growth` (the answer proposed scope growth code verified: a hold until the root agent's
  // `scope accept|reject <unit>`, src/commands/scope.ts).
  // 2026-10-16: `context-exceeded` (the call's prompt or context outgrew the model's window: an uncharged env park), at
  // plan-check, build and gate.
  'plan-check': [
    'approve', 'redirect', 'infeasible', 'escalate', 'risk-lowered', 'scope-widened', 'refusal', 'malformed', 'process-fault', 'interrupted', 'routing-changed',
    'in-session', 'read-denied', 'scope-growth', 'context-exceeded',
  ],
  // M4a rev 3 (E, R55) to dev.16: the in-session assessment found the spec `infeasible`, or raised the risk floor onto
  // another implementer seat (`risk-raised`). dev.17 records neither; read from an older log.
  // 2026-10-15 (arc feedback #3): `witness-lane-missing` (a required witness item names no arc lane in force), at build and lanes.
  build: [
    'success', 'refusal', 'malformed', 'process-fault', 'lost', 'lost-tree-effects', 'occupied', 'cleanup-failed', 'interrupted', 'routing-changed', 'infeasible',
    'risk-raised', 'witness-lane-missing', 'context-exceeded',
  ],
  quiesce: ['empty'],
  evidence: ['captured'],
  salvage: ['committed', 'committed-contract-touched', 'unmerged', 'commit-failed'],
  teardown: ['released', 'cleanup-failed'],
  // M4a rev 3 (corpus arcs, LR-h): `witnesses-missing` (D1: a required witness id absent or failing after a green certified
  // series); `smoke-survived` (D2: a mutation-smoke target survived); `known-defect` (F4: the unit hit a plan known
  // defect, uncharged, back to prepare). `base-red` (the 2026-10-15 batch): a fast suite lane red at the salvage SHA is red on
  // the unit's diff base alone too; uncharged, on to the gate (the candidate decides against the tip). `witness-lane-missing`
  // (2026-10-15, arc feedback #3): as at build. Plan defects (2026-10-16): `plan-defect` (a missing witness the lane never
  // ran, or that no build of the unit could create: an uncharged park naming the defects, src/pipeline/witnesscheck.ts);
  // `scope-growth` (salvage reverted the same out-of-scope path on the unit's last two build rounds: the hold of a
  // plan-check's proposal, with that path as the proposal, until `scope accept|reject`).
  lanes: [
    'green', 'red', 'not-certified', 'blocked', 'interrupted', 'occupied', 'cleanup-failed', 'witnesses-missing', 'smoke-survived', 'known-defect', 'base-red',
    'witness-lane-missing', 'plan-defect', 'scope-growth',
  ],
  // M4a rev 3 (paid run 11): `unverified` (no green verification checkout of the head: the lanes run again, uncharged).
  // Paid M4b run 5: `read-denied` (an approve from a session the CLI refused a read: not an approval; one uncharged retry).
  // TEMPORARY SCAFFOLDING (BACKLOG "Scaffolding to delete"): no longer recorded since 2026-10-16, when the judge's read
  // surface widened to the repository and the run dir and a refused read stopped voiding an approval; kept, with its
  // transition row, so a 1.0.0-dev.11 log whose latest gate or plan-check outcome is one still folds and retries.
  gate: ['approve', 'revise', 'escalate', 'empty-diff', 'refusal', 'malformed', 'process-fault', 'interrupted', 'routing-changed', 'unverified', 'read-denied', 'context-exceeded'],
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
 * `candidate-red`, `smoke` (M4a rev 3: a mutation-smoke fix round): a bounded round within its bound. `retry`: the stage's one uncharged retry.
 * `route-up`: re-dispatched at the role's escalation seat. `trigger`: a risk trigger (contract path touched,
 * scope growth) that puts the next judgment dispatch on the escalation seat. `hold`: the stage was interrupted
 * (a pause or stop cancel, or its backend parked arc-wide on a usage limit); the unit stays at the stage,
 * no counter moves, and a resume re-runs the stage as a new attempt. `park`, `stop`, `retire`: the unit
 * parks (needs-user), the arc stops (needs-user), the unit is done.
 */
export const OUTCOME_CLASSES = ['advance', 'redirect', 'revise', 'candidate-red', 'smoke', 'retry', 'route-up', 'trigger', 'hold', 'park', 'stop', 'retire'] as const;
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
 * re-entry. Absent only where the interim M2 shim wrote none (src/pipeline/transitions.ts `outcomeFact`): read as operator, its kind
 * by outcome (src/core/state.ts `unclassedParkRecord`).
 */
export type ParkRecord =
  | Readonly<{ class: 'retryable'; targets: readonly ProbeTarget[] }>
  | Readonly<{ class: 'operator'; kind: OperatorParkKind }>;

/**
 * Why a stage was interrupted, when not an operator pause or stop (G5): its backend parked, at the park fact's
 * seq. A covering passing probe or `resume --backend` releases exactly such holds; operator pauses stay. M4b: an
 * accepted flow proposal `pending-apply` holds new candidate starts until its revision is committed (`flow-apply`).
 * M4b rev 3 (RC-11, step H2): a unit whose run `inv` was starved, or red under pressure with its rerun pending, is held
 * until a minute of scheduler ticks since the hold shows the host's cpu wait below `PRESSURE_SATURATED` or 30 min pass (`host-pressure`).
 * Arc feedback 2026-10-15: `recovery` closes an admission-stage attempt a crash cut short that no recorded backend call
 * decides, written once at startup (src/pipeline/unit.ts `holdAbandoned`): the unit is held while it (or the arc) is
 * paused and active otherwise, and its re-run starts from the decision before, as the abandoned attempt's would have.
 */
export type HoldCause =
  | Readonly<{ type: 'backend'; backend: Backend; parkSeq: number }>
  | Readonly<{ type: 'flow-apply'; proposal: ProposalId }>
  | Readonly<{ type: 'host-pressure'; inv: InvocationId }>
  | Readonly<{ type: 'recovery' }>;

/** A witness test of an arc lane, as a required-witness or smoke detail names it. */
export type TestRef = Readonly<{ lane: LaneId; testId: string }>;
/** Test refs' order (by lane, then test id) and identity. */
export const testRefKey = (t: TestRef): string => `${t.lane}\u0000${t.testId}`;
/**
 * What an outcome carries beyond its name (M4a rev 3), present exactly on these outcomes: `witnesses-missing` (the
 * required ids absent, zero-selected, skipped or malformed: `missing`; failing: `failed`), `smoke-survived` (the
 * surviving targets and their obligations), `known-defect` (the plan entry hit: its id and the match it hit, so an edited
 * match releases the hold, src/schedule/ready.ts), build `infeasible` (the assessment's notes), lanes `base-red` (the diff base
 * the fast suite ran on alone, the fast suite lanes red there, whether they changed its checkout).
 */
export type StageOutcomeDetail =
  | Readonly<{ kind: 'witnesses-missing'; missing: readonly TestRef[]; failed: readonly TestRef[] }>
  | Readonly<{ kind: 'smoke-survived'; obligations: readonly ObligationId[]; testIds: readonly TestRef[] }>
  | Readonly<{ kind: 'known-defect'; id: KnownDefectId; match: KnownDefectMatch }>
  | Readonly<{ kind: 'infeasible'; notes: string }>
  | Readonly<{ kind: 'base-red'; base: Sha; lanes: readonly LaneId[]; changedCheckout: boolean }>
  /**
   * Scope growth (2026-10-15): the plan-check's proposals code verified (`ScopeGrowthProposal`), in answer order; at lanes
   * (plan defects, 2026-10-16) one proposal of the paths salvage reverted twice running.
   */
  | Readonly<{ kind: 'scope-growth'; proposals: readonly ScopeGrowthProposal[] }>
  /** Plan defects (2026-10-16): lanes `plan-defect`, the defects code found behind the missing witnesses (non-empty). */
  | Readonly<{ kind: 'plan-defect'; defects: readonly PlanDefect[] }>
  /**
   * 2026-10-16: plan-check, build or gate `context-exceeded`, the call whose prompt or context outgrew the model's window and
   * its prompt's size in bytes (stdin and the system prompt; dispatch.ts `verdictOf`).
   */
  | Readonly<{ kind: 'context-exceeded'; inv: InvocationId; promptBytes: number }>;
/**
 * One verified scope-growth proposal of a plan-check (src/pipeline/stages.ts `verifiedGrowth`): repository patterns outside
 * the unit's pinned scope, each matching a file at the integration tip the plan-check read (ascending, non-empty), and the
 * plan-check's reason.
 */
export type ScopeGrowthProposal = Readonly<{ patterns: readonly RepoPattern[]; reason: string }>;
/** The (stage, outcome) pairs that carry a detail, keyed `<stage>/<outcome>`, with the detail's kind. */
export const DETAILED_OUTCOMES = {
  'lanes/witnesses-missing': 'witnesses-missing', 'lanes/smoke-survived': 'smoke-survived', 'lanes/known-defect': 'known-defect', 'build/infeasible': 'infeasible',
  'lanes/base-red': 'base-red',
  'plan-check/scope-growth': 'scope-growth', 'lanes/scope-growth': 'scope-growth', 'lanes/plan-defect': 'plan-defect',
  'plan-check/context-exceeded': 'context-exceeded', 'build/context-exceeded': 'context-exceeded', 'gate/context-exceeded': 'context-exceeded',
} as const satisfies Readonly<Record<string, StageOutcomeDetail['kind']>>;

/**
 * One per (unit, stage, attempt). `chargeable` marks a design-class failure (the table's C rows); the
 * third one bounds the unit, so its class must be `park`. `park` (M2) only with class `park`; `cause` (M2)
 * only with class `hold`, absent for a pause or stop. `detail` (M4a rev 3) exactly on `DETAILED_OUTCOMES`.
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
  detail?: StageOutcomeDetail;
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
   * fence; an approval records exactly it. Present exactly on a gate's.
   */
  fingerprint?: ApprovalFingerprint;
  /**
   * 1.0.0-dev.12: what the gate's attached diff inlined and what it did not (src/git/boundeddiff.ts: files with changed
   * content not inlined and deleted files; a pure move is neither), each ascending. Only on a gate's; absent on one a
   * dev.11 executor recorded: read through `gateDiffShownOf`.
   */
  diffShown?: DiffShown;
  /**
   * 1.0.0-dev.12 (the large-diff gate): null when the attached diff inlined every file it could, else how many files with
   * changed content it left out for size (`BoundedDiff.overflow`). Above that threshold the gate sits at least at `high`
   * (transitions.ts `largeDiffSeat`), renders its large-diff method and must answer a cluster map covering the diff. Only
   * on a gate's; absent on one a dev.11 executor recorded: read through `gateLargeDiffOf`.
   */
  largeDiff?: GateLargeDiff | null;
}>;

/** The paths a gate's attached diff inlined and did not (`JudgmentInputs.diffShown`). */
export type DiffShown = Readonly<{ inlined: readonly RepoPath[]; notInlined: readonly RepoPath[] }>;
/** A gate's diff over the large-diff threshold (`JudgmentInputs.largeDiff`): the files its attachment left out for size. */
export type GateLargeDiff = Readonly<{ overflow: number }>;

export type Fact =
  | Readonly<{ kind: 'tail-discarded'; offset: number; length: number; sha256: Sha256Hex }>
  | Readonly<{ kind: 'containment-mode'; mode: ContainmentMode }>
  /** One usage fact per invocation, charged to `subject`. */
  /**
   * `usage` is what the invocation is charged. 2026-10-16, a Claude call's fact also names its `session` and the `delegated`
   * share of `usage` per usage class (its subagents' models): its result reports the session's cumulative usage, and
   * `usage` and `delegated` are that less what the session's earlier facts charged (src/core/usage.ts `chargedUsage`).
   * Both absent: a Codex call's, or one an executor before 1.0.0-dev.12 wrote (nothing delegated).
   */
  | Readonly<{
    kind: 'meter'; inv: InvocationId; routingRev: RoutingRev; subject: MeterSubject; usage: TokenUsage; session?: ClaudeSessionId; delegated?: readonly ClassUsage[];
  }>
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
   * Scope growth (2026-10-15): the root agent's `scope accept|reject <unit>` on the proposals of the unit's plan-check
   * attempt `attempt`, held `scope-growth`. Releases that hold (the unit re-runs plan-check); an accept writes it after the
   * ruled-growth revision it committed (src/commands/scope.ts).
   */
  | Readonly<{ kind: 'scope-decided'; unit: UnitId; attempt: number; command: CommandId; decision: 'accepted' | 'rejected'; reason: string }>
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
  /** `scheduling: 'dag'` (M2) on rev 1, and only there: the arc runs DAG scheduling. */
  | (Readonly<{ kind: 'plan-applied'; rev: PlanRev; command: CommandId | null; changes: readonly PlanChange[]; scheduling?: 'dag' }> & PlanManifest & PlanAppliedM3)
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
   * Legacy (D4, retired in dev.17; written by dev.16 and earlier): a fix round after a stalled one ran cold on the
   * `build.high` seat (A11, G1). `attempt` is the escalated build attempt, `stalled` the build attempt whose round stalled,
   * `from` the unit's build tier until then. No longer written; a dev.16 log's still folds (state.ts `buildTier`).
   */
  | Readonly<{ kind: 'implementer-escalated'; unit: UnitId; attempt: number; from: RiskTier; to: 'high'; stalled: number }>
  /**
   * An executor started under host generation `generation` (step 13b), written at every start once the
   * journal is open. It clears the stop marker: a stop ends one run, not the arc. Pause markers and holds
   * persist until a `resume`.
   */
  /**
   * `host` (M4b, additive): this start's host fingerprint; absent on a 1.0.0-dev.7 start. `pressure` (M4b rev 3,
   * additive): whether this host reports schedstat cpu wait (src/host/pressure.ts); absent on an earlier start, read as
   * `unavailable` (`startPressureOf`). A sibling of the fingerprint, which seeds and givens compare by field equality.
   */
  | Readonly<{ kind: 'executor-started'; generation: number; host?: HostFingerprint; pressure?: PressureAvailability }>
  /**
   * The gate at `attempt` approved the unit, bound to `fingerprint` (R2): recorded before its stage-outcome,
   * read by the candidate and ff stages, and re-checked at T before `integration.ff`.
   */
  | Readonly<{ kind: 'approval'; unit: UnitId; attempt: number; fingerprint: ApprovalFingerprint }>
  | StageOutcomeFact
  | HolisticFact
  | M4aFact
  | FlowFact
  | WalkFact;
export type FactRecord = Readonly<{ type: 'fact'; fact: Fact }>;

/**
 * M3 fields of `plan-applied`: `source` (G1); `payloadSha256` (the kept `inputs/<sha>.revision.json` it was appended
 * from); the ledger's, obligations' and vision's bytes in force (`visionSha256` present exactly while the arc is
 * holistic); `publication` (the docs publication that carried it, absent: none); `routingProvenance` (H7).
 */
export type PlanAppliedM3 = Readonly<{
  source: RevisionSource;
  payloadSha256: Sha256Hex;
  rulingsSha256: Sha256Hex;
  obligationsSha256?: Sha256Hex;
  visionSha256?: Sha256Hex;
  publication?: Readonly<{ pub: JobId; head: Sha }>;
  routingProvenance: RoutingProvenance;
}>;

/**
 * Whom a witness run certified or measured: a candidate, a job (audit, baseline, docs, batch), or a mutant (G13): a
 * finding's, or (M4a rev 3, D2) a unit attempt's mutation smoke of the salvaged tree `of`. A mutant never certifies.
 */
export type WitnessFor =
  | Readonly<{ type: 'candidate'; unit: UnitId; attempt: number }>
  | Readonly<{ type: 'job'; job: JobId }>
  | Readonly<{ type: 'mutant'; finding: FindingId; of: Sha }>
  | Readonly<{ type: 'smoke'; unit: UnitId; attempt: number; of: Sha }>;

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
  /**
   * The lens-range fix (2026-10-16): the byte budget each lens chunk's and the owners' attached diffs keep within
   * (src/holistic/lensdiff.ts). Absent on an audit an earlier executor started: read through `auditDiffBudgetOf`.
   */
  diffBudget?: number;
}>;

/** One lens's covered range: `from` its watermark before, `to` how far its reported chunks reached (at most the audited SHA). */
export type CoveredRange = Readonly<{ lens: LensKindName; from: Sha; to: Sha }>;

/**
 * A lens draft an audit refused at admission (H6; M4b, paid run 3): a vacuity mutant that could not be made against the
 * audited tree, from the lens's call `attempt`, with the reason (git's stderr for a corrupt pre-M4b patch). Its finding
 * was not opened.
 */
export type LensRefusal = Readonly<{ lens: LensKindName; attempt: number; claim: string; cause: string; reason: string }>;

/** The M3 facts (SCHEMAS.md "M3: the holistic layer"). */
export type HolisticFact =
  /** A witness run's records (`witness.json`, hashed): the observation key and whom it ran for. */
  | Readonly<{ kind: 'witnessed'; lane: LaneId; laneRev: LaneRev; envId: EnvId; treeSha: Sha; inv: InvocationId; recordsSha256: Sha256Hex; purpose: WitnessPurpose; for: WitnessFor }>
  /** A future obligation delivered and held on its publication: it is must-hold from here (after `ff{published}`, before the snapshot). */
  | Readonly<{ kind: 'obligation-latched'; obligation: ObligationId; unit: UnitId; treeSha: Sha }>
  /** dev.13: `milestone` exactly on a `walkthrough` finding (absent on every other: none). */
  | Readonly<{
    kind: 'finding-opened'; id: FindingId; key: Sha256Hex; lens: FindingLens; severity: FindingSeverity; obligation: ObligationId | null;
    visionClauses: readonly VisionClauseId[]; claim: string; evidence: readonly FindingEvidence[]; mutant: MutantRef | null; source: FindingSource;
    gateHadPassed: boolean; milestone?: MilestoneId;
    /** dev.13: the finding's cause (its key's input), kept only on a walkthrough finding, so a later walk re-reports it alike; absent: none. */
    cause?: string;
  }>
  | Readonly<{ kind: 'finding-transition'; id: FindingId; to: FindingTo }>
  | (Readonly<{ kind: 'audit-started' }> & AuditInputs)
  /** M4b: `refused` (absent on an earlier executor's fact: none recorded), in call order. */
  | Readonly<{
    kind: 'audit-ended'; job: JobId; covered: readonly CoveredRange[]; findings: readonly FindingId[]; suppressed: number; outcome: 'completed' | 'abandoned';
    refused?: readonly LensRefusal[];
  }>
  /** A17, H8: a docs-only publication covers its own edge U→D by construction. */
  | Readonly<{ kind: 'docs-covered'; pub: JobId; from: Sha; to: Sha }>
  /** M4a: `issues` (the checkpoint's issue capture; absent on a dev.6 fact: none) and `corpusSha256` (the pin in force; absent: none). */
  | Readonly<{
    kind: 'checkpoint-inputs'; job: JobId; trigger: CheckpointTrigger; generation: number; vector: RevisionVector; headSha: Sha; visionSha256: Sha256Hex;
    findings: readonly FindingId[]; observations: readonly ObservationKey[]; issues?: CheckpointIssues; corpusSha256?: Sha256Hex;
  }>
  | Readonly<{ kind: 'bundle-decided'; job: JobId; outcome: BundleOutcome }>
  /**
   * Arc feedback 2026-10-16: the checkpoint after a completed audit is not run, because the audit found nothing new: it is
   * not the final one, a checkpoint already settled under the vision in force, and every active finding no unit owns was
   * captured by such a checkpoint (src/holistic/checkpoint.ts `nothingNew`), and in a corpus arc every open issue was
   * captured, unchanged, by such a checkpoint (src/holistic/intake.ts `unseenIssues`). `carried`: the findings the audit reported.
   * `generation` is the audit's, quiescent under `visionSha256` (src/holistic/convergence.ts).
   */
  | Readonly<{ kind: 'checkpoint-skipped'; audit: JobId; generation: number; visionSha256: Sha256Hex; carried: readonly FindingId[] }>
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

/**
 * Where a corpus amendment came from (M4a): a checkpoint's proposal, a divergence code derived it from, or an issue's
 * intake; since M4a rev 3 (R35) a checkpoint `admit` op code converted (`index` the op's, `reason` the conversion's); since
 * run 10 (E) a bundle request the close-out declined.
 */
export type AmendmentSource =
  | Readonly<{ type: 'checkpoint'; job: JobId; index: number }>
  | Readonly<{ type: 'divergence'; divergence: DivergenceId }>
  | Readonly<{ type: 'issue'; job: JobId; issue: IssueId }>
  | Readonly<{ type: 'admit'; job: JobId; index: number; reason: ConversionReason }>
  /** Run 10 (E): a non-blocking bundle request of checkpoint `job` nobody answered by the close-out, declined by the executor. */
  | Readonly<{ type: 'request'; job: JobId; needsUser: NeedsUserId }>;

/** A checkpoint's issues (M4a, R21): the kept capture, or why none was taken (non-fatal, never a park). */
export type CheckpointIssues = Readonly<{ type: 'captured'; sha256: Sha256Hex }> | Readonly<{ type: 'unavailable'; reason: string }>;

/** A mutation smoke's per-target verdicts (D2, Q15), each list ascending by lane then test id. */
export type SmokeVerdict = Readonly<{ killed: readonly TestRef[]; survived: readonly TestRef[]; inconclusive: readonly TestRef[] }>;

/**
 * The M4a facts (SCHEMAS.md "M4a"); their behaviour is A4's (debt), C3's (amendments, intake, pack review, captures).
 * M4a rev 3: `lane-reused`, `series-certified` (N1), `smoke-ran` (N3), `finding-corroborated` (N5).
 */
export type M4aFact =
  /**
   * A debt item banked (R7): after the approving gate's `approval`, or a checkpoint's deferral; idempotent per `source`.
   * `opportunity` (M4a rev 3, LR-k) exactly on an `opportunity-overrun` item: the opportunity it names.
   */
  | Readonly<{ kind: 'debt-banked'; id: DebtId; bankReason: BankReason; what: string; key: Sha256Hex; source: DebtSource; opportunity?: OpportunityId }>
  /**
   * A series reused a lane's earlier pass instead of running it (F1a, R52), written before the lane would have run;
   * keyed `(parent, lane)`. `from`: the reused execution's series parent, invocation and SHA.
   */
  | Readonly<{ kind: 'lane-reused'; parent: Parent; lane: LaneId; from: Readonly<{ parent: Parent; inv: InvocationId; at: Sha }> }>
  /**
   * A series' completed clean certificate (Q12, R51): its lanes ran, its checkout's census was clean and its checkout was
   * removed. Absence is unknown, never clean: an uncertified series is never reused. One per `(parent, checkout)`.
   */
  | Readonly<{ kind: 'series-certified'; parent: Parent; checkout: AbsPath; at: Sha }>
  /** A unit attempt's mutation smoke ran (D2, Q17): `key` its allowance key; a later attempt with the same key reuses `verdict`. */
  | Readonly<{ kind: 'smoke-ran'; unit: UnitId; attempt: number; key: Sha256Hex; verdict: SmokeVerdict }>
  /** A second lens's draft merged into finding `id` within one audit (H7, R62): its lens and claim, kept as its rationale. */
  | Readonly<{ kind: 'finding-corroborated'; id: FindingId; lens: LensKindName; claim: string }>
  /**
   * Run 10 (E): the executor declined a non-blocking needs-user item nobody answered by the close-out (a `bundle-request`),
   * so a non-blocking item never holds completion. It closes the item as an acknowledgement would (`choice`: the item's
   * declining option, `reject` or `decline`, null when it offers none), with no `.ack.json` twin; at most once per id, and
   * never with a `needs-user-acked`.
   */
  | Readonly<{ kind: 'needs-user-declined'; id: NeedsUserId; choice: string | null; reason: string }>
  /** A proposed change to the corpus, dispositioned at the next Phase 0. */
  | Readonly<{ kind: 'corpus-amendment'; id: AmendmentId; source: AmendmentSource; rules: readonly RuleId[]; proposal: string; why: string; evidence: readonly string[] }>
  /** A checkpoint's one outcome for one captured issue; once per `(job, issue)`. */
  | Readonly<{ kind: 'issue-intake'; job: JobId; issue: IssueId; outcome: IssueIntakeOutcome }>
  /** A pack review's kept inputs (K8): written after `inputs/<inputsSha256>.pack-review.json` and before the spawn; `key` its required-review key. */
  | Readonly<{ kind: 'pack-review-started'; job: JobId; planRev: PlanRev; inputsSha256: Sha256Hex; key: Sha256Hex }>
  /**
   * A pack review's findings, each identified by `(job, index)` (K13). `dispositions` (M4a rev 3, H3): a completed delta
   * re-review's disposition of each unresolved finding of the reviews before it, by origin `(job, index)`; absent on a
   * full review (the first, or after an abandoned one) and on an abandoned one.
   */
  | Readonly<{ kind: 'pack-review-ended'; job: JobId; outcome: 'completed' | 'abandoned'; findings: readonly PackFinding[]; dispositions?: readonly PackDisposition[] }>
  /** A checkpoint's issue capture kept as `inputs/<sha256>.issues.json`, before its `checkpoint-inputs` (H13: the repo it resolved once). */
  | Readonly<{ kind: 'issues-captured'; job: JobId; sha256: Sha256Hex; repo: RepoIdentity; filtered: Readonly<{ comments: number; pullRequests: number }> }>;

/**
 * The M4b facts (SCHEMAS.md "M4b"); their behaviour is the later steps' (B1: series, runs; B2: decisions, proofs,
 * applies; A2: verdicts). The fold sees the jobs they name and nothing else yet.
 */
export type FlowFact =
  /** The arc's compact flow series kept as `inputs/<sha256>.flow-series.json`, right before an `arc-completed`; covers events up to `highWater`. */
  | Readonly<{ kind: 'flow-series'; sha256: Sha256Hex; highWater: number }>
  /** A flow run's kept inputs (`inputs/<inputsSha256>.flow-inputs.json`), written under the fence before its call. */
  | Readonly<{ kind: 'flow-started'; job: JobId; triggers: readonly FlowTrigger[]; inputsSha256: Sha256Hex }>
  /**
   * A flow run's end: `done` with the surviving proposal or none (`dropped`: the proposal code's checks dropped, with the
   * reason), or `invalid` (no valid answer after one retry) or `failed`, with neither. `proposal.id` is `<job>.0`.
   */
  | Readonly<{ kind: 'flow-ended'; job: JobId; outcome: FlowOutcome; proposal: FlowProposal | null; dropped: FlowDropped | null; constraint: FlowEndedConstraint }>
  /** `roadmap flow request --reason` (RC-5): bypasses the cooldown, at most once per cooldown window. */
  | Readonly<{ kind: 'flow-requested'; command: CommandId; reason: string }>
  /** `roadmap flow accept|reject <proposal> --reason`: once per proposal. A rejection adds its RC-9 key. */
  | Readonly<{ kind: 'flow-decided'; proposal: ProposalId; command: CommandId; decision: 'accepted' | 'rejected'; reason: string }>
  /**
   * A suite-lane proof of an accepted proposal (RC-4), proof job `job` at the integration head's tree `treeSha`: the old and
   * new argv's kept witness records (`inputs/<sha>.flow-proof.json`) and minutes, present for `preserved` and `changed`;
   * `breaksStandIn`: the new argv would break the lane's F6 stand-in.
   */
  | Readonly<{
    kind: 'flow-proof'; proposal: ProposalId; job: JobId; treeSha: Sha; oldSha256: Sha256Hex | null; newSha256: Sha256Hex | null; outcome: ProofOutcome;
    minutes: ProofMinutes | null; breaksStandIn: boolean;
  }>
  /** An accepted proposal in force: plan revision `revision` (source `flow{proposal}`), and what it replaced. */
  | Readonly<{ kind: 'flow-applied'; proposal: ProposalId; revision: PlanRev; preimage: FlowPreimage }>
  /** An applied proposal's verdict window closed (fires `verdict-closed`); `worse` raises `flow-worse` and adds the RC-9 key. */
  | Readonly<{
    kind: 'flow-verdict'; proposal: ProposalId; metric: FlowMetric; before: VerdictBefore; after: VerdictAfter; guards: readonly GuardBreach[];
    verdict: FlowVerdictKind; preimage: FlowPreimage;
  }>;
export type FlowFactKind = FlowFact['kind'];

/** How a milestone walk ended: its report read (`reported`), its product never came up (`bring-up-failed`), or neither. */
export const WALK_OUTCOMES = ['reported', 'bring-up-failed', 'abandoned'] as const;
export type WalkOutcome = (typeof WALK_OUTCOMES)[number];
export const TWEAK_DECISIONS = ['keep', 'drop'] as const;
export type TweakDecision = (typeof TWEAK_DECISIONS)[number];
/** `judged`: the polish judge decided; `reference-untouched`: the diff touched no milestone reference (a drop, no call). */
/**
 * `judged`: the polish judge's decision; `reference-untouched`: code's drop of a diff that touches no milestone reference;
 * `bring-up-failed` (dev.13 agent D): code's drop of a tweak whose after instance did not come up while the before did;
 * `abandoned` (lead ruling): code's drop of a tweak whose compare failed COMPARE_ATTEMPTS times (src/walk/compare.ts).
 */
export const TWEAK_REASONS = ['judged', 'reference-untouched', 'bring-up-failed', 'abandoned'] as const;
export type TweakReason = (typeof TWEAK_REASONS)[number];
/** A polish proposal's unit as the walkthrough authored it: `spec` is spec.json's canonical text (an admit's). */
export type PolishUnitDraft = Readonly<{ id: UnitId; scope: readonly RepoPattern[]; spec: string }>;

/**
 * The dev.13 facts (SCHEMAS.md "dev.13: milestone walkthroughs and design units"); their behaviour is agents C, D and G's.
 * The fold keeps them in log order (`walkFacts`) and holds their ids to order.
 */
export type WalkFact =
  /** A milestone walk began (`walk-n`, round `round`, on integration SHA `sha` captured under the fence), its product up on `ports`. */
  | Readonly<{ kind: 'walk-started'; job: JobId; milestone: MilestoneId; round: number; sha: Sha; ports: Readonly<Record<ServeName, number>> }>
  /**
   * A walk's end: the findings it opened (a failed bring-up's code-opened P1 included) and the polish it proposed, both in
   * id order; `dropped` the proposals not applied (every proposal of the milestone's last round: the milestone settles).
   */
  | Readonly<{
    kind: 'walk-ended'; job: JobId; outcome: WalkOutcome; findings: readonly FindingId[]; proposals: readonly PolishId[]; dropped: readonly PolishId[];
    /** Lead ruling (agent D): present (true) only on an abandoned walk a pause, a stop or a backend park cut short; it is no try of the round's brake. */
    interrupted?: true;
  }>
  /** A walk's polish proposal, written before its `walk-ended`; never a finding, never debt. */
  | Readonly<{
    kind: 'polish-proposed'; id: PolishId; job: JobId; milestone: MilestoneId; journey: JourneyId; evidence: readonly string[]; text: string; unit: PolishUnitDraft;
  }>
  /** A polish unit's compare stage decided (once per unit): `keep` goes on to candidate admission, `drop` cuts it (`polish-dropped`). */
  | Readonly<{ kind: 'tweak-judged'; unit: UnitId; decision: TweakDecision; reason: TweakReason }>
  /**
   * Agent D: a polish proposal the code-applied polish revision refused (once per proposal): its scope covers no milestone
   * reference, it is not from its milestone's latest round, or the admit path refused its unit. Settled: never applied.
   */
  | Readonly<{ kind: 'polish-refused'; proposal: PolishId; reasons: readonly string[] }>
  /**
   * Agent D: a polish unit's compare job (`compare-<n>`) began: `before` the integration tip and `after` the unit's approved
   * commit (its salvage tree), each brought up on its own `ports`. Its `tweak-judged` (or `compare-abandoned`) ends it.
   */
  | Readonly<{
    kind: 'compare-started'; job: JobId; unit: UnitId; before: Sha; after: Sha;
    ports: Readonly<{ before: Readonly<Record<ServeName, number>>; after: Readonly<Record<ServeName, number>> }>;
  }>
  /**
   * Agent D: a compare that could not judge (the before instance did not come up, the judge failed twice; `interrupted`: a
   * pause, a stop or a backend park cut it short). A later compare runs, once: a unit's COMPARE_ATTEMPTS-th abandonment
   * that was not interrupted is followed by `tweak-judged{drop, abandoned}` and the cut.
   */
  | Readonly<{ kind: 'compare-abandoned'; job: JobId; detail: string; interrupted?: true }>
  /** The milestone node passed: walk `job` completed and the milestone has no active walkthrough P1 (once per milestone). */
  | Readonly<{ kind: 'milestone-passed'; milestone: MilestoneId; job: JobId }>
  /** The demo (`refs/roadmap/demo`) moved to `sha`, the settled tip of `milestone` (or the completed arc's, its last settled milestone). */
  | Readonly<{ kind: 'demo-promoted'; milestone: MilestoneId; sha: Sha }>
  /** The demo's bring-up of `sha` failed (the old instance keeps serving); `log` its captured output. Opens a walkthrough P1 on `milestone`. */
  | Readonly<{ kind: 'demo-failed'; milestone: MilestoneId; sha: Sha; log: AbsPath }>
  /** The owner's act on the demo (`roadmap demo <act>`, its command `command`): the fold reads `held` and `up` from these. */
  | Readonly<{ kind: 'demo-acted'; command: CommandId; act: DemoAct }>;
export type WalkFactKind = WalkFact['kind'];

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
  | Readonly<{ type: 'unit-reentered'; unit: UnitId; reenters: UnitId; reset: boolean; widened?: ReentryWidening }>
  /** M3: an obligation added, split (H14), re-witnessed, or disposed by a ruling in force (weakening). */
  | Readonly<{ type: 'obligation'; id: ObligationId; edit: ObligationEdit }>
  | Readonly<{ type: 'mapping' }>
  /** M3: the vision's new `rev` (owner-only: source `command`). */
  | Readonly<{ type: 'vision'; rev: number }>
  /** M3: a unit's `limits`, or the plan's (null). */
  | Readonly<{ type: 'limits'; unit: UnitId | null }>
  /** M3 (A5): the plan gained `holistic`. */
  | Readonly<{ type: 'holistic' }>
  /** M3: `holistic.advances`, the arc's slice of the vision, changed (owner-only). */
  | Readonly<{ type: 'advances' }>
  /**
   * M4a (H7): a re-pin of the corpus (source `command` only): the new pin's and its guide's bytes. Triggers a drift audit
   * (`L ∩ {drift, vision}`), re-gates every approval through the fingerprint's `corpus`, and before the first admission
   * changes the required-review key.
   */
  | Readonly<{ type: 'corpus'; pinSha256: Sha256Hex; guideSha256: Sha256Hex }>
  /** M4a (H7): a Phase-0 record edit (source `command` only), with its issue capture; changes only the required-review key. */
  | Readonly<{ type: 'phase0'; sha256: Sha256Hex; issuesSha256: Sha256Hex }>
  /** M4a rev 3 (F1b): a unit's `priority` changed (no drain; any status but merged). */
  | Readonly<{ type: 'unit-priority'; unit: UnitId }>
  /** M4a rev 3 (F4): the plan's `knownDefects` changed. */
  | Readonly<{ type: 'known-defects' }>
  /** M4a rev 3 (E) to dev.16: the plan's `planCheck.shape` changed (no drain). Read from older logs; dev.17 writes none. */
  | Readonly<{ type: 'plan-check-shape' }>
  /** Plan defects (2026-10-16): the plan's `derived` entries changed (no drain; each unit re-pins its widening at its next dispatch check). */
  | Readonly<{ type: 'derived' }>
  /**
   * dev.13: the plan's `milestones` changed (an `apply` only; the checkpoint cannot edit them). Classified by src/input/classify.ts.
   * `rewalk`: the walked milestones whose `bringUp` or `journeys` the apply edited, each a fresh start for its walk abandonment
   * brake (src/walk/milestones.ts); absent: none (lasting).
   */
  | Readonly<{ type: 'milestones'; rewalk?: readonly MilestoneId[] }>;

/**
 * M4a rev 3 (F5): a re-entry leaving its lineage's scope envelope, accepted on an active ruling applying to the new unit
 * whose statement names exactly the added patterns (ascending, non-empty).
 */
export type ReentryWidening = Readonly<{ patterns: readonly RepoPattern[]; ruling: RulingId }>;

/**
 * `restored` (M3 step A2): an exempt obligation active again; `edited`: its serves, contracts, deliveredBy changed, or
 * future → must-hold (strengthening, no ruling needed).
 */
export const OBLIGATION_EDITS = ['added', 'split', 'witness', 'disposed', 'restored', 'edited'] as const;
export type ObligationEdit = (typeof OBLIGATION_EDITS)[number];

/**
 * A revision's full evaluated payload (G1), kept content-addressed as `inputs/<sha256>.revision.json` and named by
 * its `revision.commit` intent before any docs `ff`. `plan-applied` is appended from it exactly, then its
 * divergences in order; recovery never reclassifies. `publication`: the files the docs publication commits (`renders`:
 * the rendered `.roadmap/` documents and, dev.16, the vision files the revision changes in the product repo) and its
 * contract ops, null when the revision changes no in-tree document. `owner` (apply rebase, 2026-10-16):
 * the owner's files a start or an `apply` was rebased from, when they differ from `manifest` (a merge, or `--ruling`
 * records landed): the default base of the owner's next apply (src/input/rebase.ts `ownerBase`). Absent: the manifest is
 * the owner's (every revision of an earlier release, whose write-back kept the owner's files at the manifest).
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
  owner?: RevisionManifest;
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
const proposalR: Read<ProposalId> = (v, p) => proposalId(v, p);
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
  bundle: object((f): RevisionSource => {
    const admits = f.optional('admits', sortedBy(classifiedAdmit, (x) => String(x.index).padStart(6, '0'), { order: 'by op index' }));
    const conversions = f.optional('conversions', sortedBy(conversion, (x) => String(x.index).padStart(6, '0'), { order: 'by op index' }));
    if (admits !== undefined && conversions === undefined) throw new SchemaError(`${f.path}.conversions`, 'conversions beside admits (a classified bundle)', { admits, conversions });
    const out = { type: f.get('type', literal('bundle')), job: f.get('job', (v, p) => jobIdOfKind('ckpt')(v, p)) };
    if (conversions === undefined) return out;
    if (admits === undefined) {
      // dev.13: a brake's conversions outside a corpus arc (none classified).
      if (conversions.length === 0 || conversions.some((c) => c.reason !== 'regress-brake' && c.reason !== 'settled-brake')) {
        throw new SchemaError(`${f.path}.conversions`, 'admits beside conversions (a classified bundle), or only a brake\'s conversions', conversions);
      }
      return { ...out, conversions };
    }
    const both = [...admits.map((a) => a.index), ...conversions.map((c) => c.index)];
    if (new Set(both).size !== both.length) throw new SchemaError(`${f.path}.conversions`, 'op indices an admit class does not also name', both);
    return { ...out, admits, conversions };
  }),
  executor: object((f): RevisionSource => ({ type: f.get('type', literal('executor')), inv: f.get('inv', invR) })),
  flow: object((f): RevisionSource => ({ type: f.get('type', literal('flow')), proposal: f.get('proposal', proposalR) })),
  walk: object((f): RevisionSource => ({ type: f.get('type', literal('walk')), job: f.get('job', (v, p) => jobIdOfKind('walk')(v, p)) })),
  compare: object((f): RevisionSource => ({ type: f.get('type', literal('compare')), unit: f.get('unit', unitR) })),
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
  journey: object((f): SpawnSubject => {
    const redRev = f.optional('redRev', positive);
    return {
      purpose: f.get('purpose', literal('journey')), lane: f.get('lane', laneR), laneRev: f.get('laneRev', laneRevR), at: f.get('at', shaR),
      owner: f.get('owner', laneOwner), ...(redRev === undefined ? {} : { redRev }),
    };
  }),
  // M4a rev 3: `of`; a 1.0.0-dev.6 subject's `finding` reads as written (`mutantSubjectDefault`).
  mutant: object((f): SpawnSubject => {
    const base = { purpose: f.get('purpose', literal('mutant')), lane: f.get('lane', laneR), laneRev: f.get('laneRev', laneRevR), tree: f.get('tree', shaR) };
    return withMutantOf(f, base);
  }),
  lane: object((f): SpawnSubject => {
    const redRev = f.optional('redRev', positive);
    const identity = f.optional('identity', laneIdentity);
    const out = {
      purpose: f.get('purpose', literal('lane')), unit: f.get('unit', unitR), lane: f.get('lane', (v, p): LaneId => laneId(v, p)),
      set: f.get('set', oneOf(['spec', 'suite'] as const)), at: f.get('at', shaR),
      ...(redRev === undefined ? {} : { redRev }), ...(identity === undefined ? {} : { identity }),
    };
    if (identity !== undefined && out.set !== 'spec') throw new SchemaError(`${f.path}.identity`, 'absent on a suite lane (only a spec lane is reused)', identity);
    return out;
  }),
  teardown: object((f): SpawnSubject => ({ purpose: f.get('purpose', literal('teardown')), unit: f.get('unit', nullable(unitR)), resource: f.get('resource', instR) })),
  probe: object((f): SpawnSubject => ({ purpose: f.get('purpose', literal('probe')), unit: f.get('unit', nullable(unitR)), resource: f.get('resource', instR) })),
  proof: object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('proof')), job: f.get('job', (v, p) => jobIdOfKind('proof')(v, p)), proposal: f.get('proposal', proposalR), lane: f.get('lane', laneR),
    side: f.get('side', oneOf(['old', 'new'] as const)), at: f.get('at', shaR),
  })),
  'bring-up': object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('bring-up')), milestone: f.get('milestone', (v, p): MilestoneId => milestoneId(v, p)), step: f.get('step', str),
  })),
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

const mutantOf: Read<MutantOf> = tagged('type', {
  finding: object((f): MutantOf => ({ type: f.get('type', literal('finding')), finding: f.get('finding', findingR) })),
  smoke: object((f): MutantOf => ({ type: f.get('type', literal('smoke')), unit: f.get('unit', unitR), attempt: f.get('attempt', positive) })),
});
/** A mutant record's subject: `of` since M4a rev 3, or a 1.0.0-dev.6 record's `finding` (exactly one of the two). */
function withMutantOf<T extends object>(f: Fields, base: T): T & (Readonly<{ of: MutantOf }> | Readonly<{ finding: FindingId }>) {
  const of = f.optional('of', mutantOf);
  const finding = f.optional('finding', findingR);
  if ((of === undefined) === (finding === undefined)) throw new SchemaError(`${f.path}.of`, 'exactly one of of and finding (finding: a 1.0.0-dev.6 record)', { of, finding });
  return of !== undefined ? { ...base, of } : { ...base, finding: finding as FindingId };
}

const laneIdentity: Read<LaneIdentity> = object((f) => ({
  laneRev: f.get('laneRev', laneRevR), envId: f.get('envId', (v, p): EnvId => envId(v, p)),
  argv0: f.get('argv0', nullable(object((g) => ({ path: g.get('path', absR), sha256: g.get('sha256', sha256R) })))),
}));

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
      result: object((f): OpOutcome['proc.spawn'] => {
        const pressure = f.optional('pressure', nullable(fraction));
        return { kind: f.get('kind', literal('result')), resultSha256: f.get('resultSha256', sha256R), summary: f.get('summary', resultSummary), ...(pressure === undefined ? {} : { pressure }) };
      }),
      lost: object((f): OpOutcome['proc.spawn'] => ({ kind: f.get('kind', literal('lost')), treeEffects: f.get('treeEffects', bool) })),
    }),
  },
  'proc.kill': {
    expect: object((f) => ({ inv: f.get('inv', invR), scope: f.get('scope', oneOf(['invocation', 'op'] as const)), reason: f.get('reason', killReason) })),
    post: nothing,
    outcome: kindOnly('quiesced'),
  },
  'evidence.snapshot': {
    expect: object((f) => {
      const notRegular = f.optional('notRegular', arrayOf((v, p) => repoPath(v, p), { nonEmpty: true }));
      return {
        source: f.get('source', absR), globs: f.get('globs', arrayOf((v, p) => repoPattern(v, p))), dest: f.get('dest', absR),
        ...(notRegular === undefined ? {} : { notRegular }),
      };
    }),
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
    expect: object((f): MutantApplyExpect => withMutantOf(f, { worktree: f.get('worktree', absR), at: f.get('at', shaR), patchSha256: f.get('patchSha256', sha256R) })),
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
    const widened = f.optional('widened', object((g): ReentryWidening => ({
      patterns: g.get('patterns', sortedBy((v, p) => repoPattern(v, p), (x) => x, { nonEmpty: true })), ruling: g.get('ruling', (v, p): RulingId => rulingId(v, p)),
    })));
    return widened === undefined ? out : { ...out, widened };
  }),
  obligation: object((f): PlanChange => ({ type: f.get('type', literal('obligation')), id: f.get('id', obligationR), edit: f.get('edit', oneOf(OBLIGATION_EDITS)) })),
  mapping: object((f): PlanChange => ({ type: f.get('type', literal('mapping')) })),
  vision: object((f): PlanChange => ({ type: f.get('type', literal('vision')), rev: f.get('rev', positive) })),
  limits: object((f): PlanChange => ({ type: f.get('type', literal('limits')), unit: f.get('unit', nullable(unitR)) })),
  holistic: object((f): PlanChange => ({ type: f.get('type', literal('holistic')) })),
  advances: object((f): PlanChange => ({ type: f.get('type', literal('advances')) })),
  corpus: object((f): PlanChange => ({ type: f.get('type', literal('corpus')), pinSha256: f.get('pinSha256', sha256R), guideSha256: f.get('guideSha256', sha256R) })),
  phase0: object((f): PlanChange => ({ type: f.get('type', literal('phase0')), sha256: f.get('sha256', sha256R), issuesSha256: f.get('issuesSha256', sha256R) })),
  'unit-priority': object((f): PlanChange => ({ type: f.get('type', literal('unit-priority')), unit: f.get('unit', unitR) })),
  'known-defects': object((f): PlanChange => ({ type: f.get('type', literal('known-defects')) })),
  'plan-check-shape': object((f): PlanChange => ({ type: f.get('type', literal('plan-check-shape')) })),
  derived: object((f): PlanChange => ({ type: f.get('type', literal('derived')) })),
  milestones: object((f): PlanChange => {
    const rewalk = f.optional('rewalk', arrayOf(milestoneR, { nonEmpty: true }));
    return { type: f.get('type', literal('milestones')), ...(rewalk === undefined ? {} : { rewalk }) };
  }),
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
  const owner = f.optional('owner', object((g) => ({ planSha256: g.get('planSha256', sha256R), specs: g.get('specs', manifestSpecs), ...revisionInputs(g) })));
  if (out.rev !== out.base + 1) throw new SchemaError(`${f.path}.rev`, String(out.base + 1), out.rev);
  return owner === undefined ? out : { ...out, owner };
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

const scopeGrowthProposal: Read<ScopeGrowthProposal> = object((g) => ({
  patterns: g.get('patterns', sortedBy((v, p) => repoPattern(v, p), (x) => x, { nonEmpty: true })), reason: g.get('reason', str),
}));

const stageOutcomeDetail: Read<StageOutcomeDetail> = tagged('kind', {
  'witnesses-missing': object((f): StageOutcomeDetail => {
    const out = { kind: f.get('kind', literal('witnesses-missing')), missing: f.get('missing', testRefs()), failed: f.get('failed', testRefs()) };
    if (out.missing.length + out.failed.length === 0) throw new SchemaError(f.path, 'a missing or failed witness', out);
    return out;
  }),
  'smoke-survived': object((f): StageOutcomeDetail => ({
    kind: f.get('kind', literal('smoke-survived')), obligations: f.get('obligations', idList(obligationR)), testIds: f.get('testIds', testRefs({ nonEmpty: true })),
  })),
  'known-defect': object((f): StageOutcomeDetail => ({
    kind: f.get('kind', literal('known-defect')), id: f.get('id', (v, p) => knownDefectId(v, p)), match: f.get('match', knownDefectMatch),
  })),
  infeasible: object((f): StageOutcomeDetail => ({ kind: f.get('kind', literal('infeasible')), notes: f.get('notes', str) })),
  'base-red': object((f): StageOutcomeDetail => {
    const out = {
      kind: f.get('kind', literal('base-red')), base: f.get('base', shaR), lanes: f.get('lanes', arrayOf(laneR)), changedCheckout: f.get('changedCheckout', bool),
    };
    if (out.lanes.length === 0 && !out.changedCheckout) throw new SchemaError(f.path, 'a red lane or a changed checkout', out);
    return out;
  }),
  'scope-growth': object((f): StageOutcomeDetail => ({ kind: f.get('kind', literal('scope-growth')), proposals: f.get('proposals', arrayOf(scopeGrowthProposal, { nonEmpty: true })) })),
  'plan-defect': object((f): StageOutcomeDetail => ({ kind: f.get('kind', literal('plan-defect')), defects: f.get('defects', arrayOf(planDefect, { nonEmpty: true })) })),
  'context-exceeded': object((f): StageOutcomeDetail => ({
    kind: f.get('kind', literal('context-exceeded')), inv: f.get('inv', invR), promptBytes: f.get('promptBytes', nat),
  })),
});

const holdCause: Read<HoldCause> = tagged('type', {
  backend: object((f): HoldCause => ({ type: f.get('type', literal('backend')), backend: f.get('backend', backend), parkSeq: f.get('parkSeq', positive) })),
  'flow-apply': object((f): HoldCause => ({ type: f.get('type', literal('flow-apply')), proposal: f.get('proposal', proposalR) })),
  'host-pressure': object((f): HoldCause => ({ type: f.get('type', literal('host-pressure')), inv: f.get('inv', invR) })),
  recovery: object((f): HoldCause => ({ type: f.get('type', literal('recovery')) })),
});

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
  smoke: object((f): WitnessFor => ({ type: f.get('type', literal('smoke')), unit: f.get('unit', unitR), attempt: f.get('attempt', positive), of: f.get('of', shaR) })),
});
const lensR = oneOf(LENS_KIND_NAMES);
const lensSet: Read<readonly LensKindName[]> = sortedBy(lensR, (l) => l, { nonEmpty: true });
const findingSet: Read<readonly FindingId[]> = idList(findingR, { legacyStringOrder: true });
const auditJobR: Read<JobId> = (v, p) => jobIdOfKind('audit')(v, p);
const ckptJobR: Read<JobId> = (v, p) => jobIdOfKind('ckpt')(v, p);

const bundleOutcome: Read<BundleOutcome> = tagged('kind', {
  'no-op': object((f): BundleOutcome => {
    const conversions = f.optional('conversions', sortedBy(conversion, (x) => String(x.index).padStart(6, '0'), { nonEmpty: true, order: 'by op index' }));
    return { kind: f.get('kind', literal('no-op')), ...(conversions === undefined ? {} : { conversions }) };
  }),
  rejected: object((f): BundleOutcome => {
    const out = { kind: f.get('kind', literal('rejected')), reason: f.get('reason', oneOf(BUNDLE_REJECTIONS)), detail: f.get('detail', str) };
    const units = f.optional('units', sortedBy(
      object((g): BusyAttempt => ({ unit: g.get('unit', unitR), stage: g.get('stage', stage), attempt: g.get('attempt', positive) })), (x) => x.unit, { nonEmpty: true },
    ));
    if ((out.reason === 'busy') !== (units !== undefined)) throw new SchemaError(`${f.path}.units`, out.reason === 'busy' ? 'the open attempts a busy bundle touched' : 'absent unless busy', units);
    return units === undefined ? out : { ...out, units };
  }),
  requested: object((f): BundleOutcome => ({ kind: f.get('kind', literal('requested')), needsUser: f.get('needsUser', (v, p) => needsUserId(v, p)) })),
});

const reviewJobR: Read<JobId> = (v, p) => jobIdOfKind('review')(v, p);
const ruleList: Read<readonly RuleId[]> = idList((v, p) => ruleId(v, p), { legacyStringOrder: true });

const checkpointIssues: Read<CheckpointIssues> = tagged('type', {
  captured: object((f): CheckpointIssues => ({ type: f.get('type', literal('captured')), sha256: f.get('sha256', sha256R) })),
  unavailable: object((f): CheckpointIssues => ({ type: f.get('type', literal('unavailable')), reason: f.get('reason', str) })),
});

const amendmentSource: Read<AmendmentSource> = tagged('type', {
  checkpoint: object((f): AmendmentSource => ({ type: f.get('type', literal('checkpoint')), job: f.get('job', ckptJobR), index: f.get('index', nat) })),
  divergence: object((f): AmendmentSource => ({ type: f.get('type', literal('divergence')), divergence: f.get('divergence', (v, p) => divergenceId(v, p)) })),
  issue: object((f): AmendmentSource => ({ type: f.get('type', literal('issue')), job: f.get('job', ckptJobR), issue: f.get('issue', (v, p) => issueId(v, p)) })),
  admit: object((f): AmendmentSource => ({
    type: f.get('type', literal('admit')), job: f.get('job', ckptJobR), index: f.get('index', nat), reason: f.get('reason', oneOf(CONVERSION_REASONS)),
  })),
  request: object((f): AmendmentSource => ({
    type: f.get('type', literal('request')), job: f.get('job', ckptJobR), needsUser: f.get('needsUser', (v, p): NeedsUserId => needsUserId(v, p)),
  })),
});

const testRef: Read<TestRef> = object((f) => ({ lane: f.get('lane', laneR), testId: f.get('testId', str) }));
/** Test refs ascending by lane, then test id, each once. */
const testRefs = (opts: Readonly<{ nonEmpty?: boolean }> = {}): Read<readonly TestRef[]> => sortedBy(testRef, testRefKey, { ...opts, order: 'by lane, then test id' });
const smokeVerdict: Read<SmokeVerdict> = object((f) => {
  const out = { killed: f.get('killed', testRefs()), survived: f.get('survived', testRefs()), inconclusive: f.get('inconclusive', testRefs()) };
  const all = [...out.killed, ...out.survived, ...out.inconclusive].map(testRefKey);
  if (all.length === 0) throw new SchemaError(f.path, 'at least one target', out);
  if (new Set(all).size !== all.length) throw new SchemaError(f.path, 'each target in one verdict', out);
  return out;
});

export type M4aFactKind = M4aFact['kind'];
/** The readers of the M4a facts, spread into `fact`. */
const M4A_FACT_READERS: { readonly [K in M4aFactKind]: Read<Fact> } = {
  'debt-banked': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('debt-banked')), id: f.get('id', (v, p) => debtId(v, p)), bankReason: f.get('bankReason', oneOf(BANK_REASONS)), what: f.get('what', str),
      key: f.get('key', sha256R), source: f.get('source', debtSource),
    };
    const opportunity = f.optional('opportunity', (v, p) => opportunityId(v, p));
    if ((out.bankReason === 'opportunity-overrun') !== (opportunity !== undefined)) {
      throw new SchemaError(`${f.path}.opportunity`, out.bankReason === 'opportunity-overrun' ? 'the opportunity an overrun names' : 'absent (only an opportunity overrun names one)', opportunity);
    }
    if ((out.bankReason === 'opportunity-overrun') !== (out.source.type === 'admit')) throw new SchemaError(`${f.path}.source`, out.bankReason === 'opportunity-overrun' ? 'the admit that overran' : 'a gate or finding source', out.source);
    return opportunity === undefined ? out : { ...out, opportunity };
  }),
  'lane-reused': object((f): Fact => ({
    kind: f.get('kind', literal('lane-reused')), parent: f.get('parent', parent), lane: f.get('lane', laneR),
    from: f.get('from', object((g) => ({ parent: g.get('parent', parent), inv: g.get('inv', invR), at: g.get('at', shaR) }))),
  })),
  'series-certified': object((f): Fact => ({ kind: f.get('kind', literal('series-certified')), parent: f.get('parent', parent), checkout: f.get('checkout', absR), at: f.get('at', shaR) })),
  'smoke-ran': object((f): Fact => ({
    kind: f.get('kind', literal('smoke-ran')), unit: f.get('unit', unitR), attempt: f.get('attempt', positive), key: f.get('key', sha256R), verdict: f.get('verdict', smokeVerdict),
  })),
  'finding-corroborated': object((f): Fact => ({ kind: f.get('kind', literal('finding-corroborated')), id: f.get('id', findingR), lens: f.get('lens', lensR), claim: f.get('claim', str) })),
  'needs-user-declined': object((f): Fact => ({
    kind: f.get('kind', literal('needs-user-declined')), id: f.get('id', (v, p): NeedsUserId => needsUserId(v, p)), choice: f.get('choice', nullable(optionId)),
    reason: f.get('reason', str),
  })),
  'corpus-amendment': object((f): Fact => ({
    kind: f.get('kind', literal('corpus-amendment')), id: f.get('id', (v, p) => amendmentId(v, p)), source: f.get('source', amendmentSource),
    rules: f.get('rules', ruleList), proposal: f.get('proposal', str), why: f.get('why', str), evidence: f.get('evidence', arrayOf(str)),
  })),
  'issue-intake': object((f): Fact => ({
    kind: f.get('kind', literal('issue-intake')), job: f.get('job', ckptJobR), issue: f.get('issue', (v, p) => issueId(v, p)), outcome: f.get('outcome', issueIntakeOutcome),
  })),
  'pack-review-started': object((f): Fact => ({
    kind: f.get('kind', literal('pack-review-started')), job: f.get('job', reviewJobR), planRev: f.get('planRev', planRevR), inputsSha256: f.get('inputsSha256', sha256R),
    key: f.get('key', sha256R),
  })),
  'pack-review-ended': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('pack-review-ended')), job: f.get('job', reviewJobR), outcome: f.get('outcome', oneOf(['completed', 'abandoned'] as const)),
      findings: f.get('findings', arrayOf(packFinding)),
    };
    out.findings.forEach((x, i) => {
      if (x.index !== i) throw new SchemaError(`${f.path}.findings[${i}].index`, String(i), x.index);
    });
    if (out.outcome === 'abandoned' && out.findings.length > 0) throw new SchemaError(`${f.path}.findings`, 'none for an abandoned review', out.findings);
    const dispositions = f.optional('dispositions', arrayOf(packDisposition));
    if (dispositions === undefined) return out;
    if (out.outcome === 'abandoned') throw new SchemaError(`${f.path}.dispositions`, 'none for an abandoned review', dispositions);
    assertUnique(dispositions, (d) => `${d.job}#${d.index}`, `${f.path}.dispositions`);
    return { ...out, dispositions };
  }),
  'issues-captured': object((f): Fact => ({
    kind: f.get('kind', literal('issues-captured')), job: f.get('job', ckptJobR), sha256: f.get('sha256', sha256R), repo: f.get('repo', repoIdentity),
    filtered: f.get('filtered', object((g) => ({ comments: g.get('comments', nat), pullRequests: g.get('pullRequests', nat) }))),
  })),
};

const flowJobR: Read<JobId> = (v, p) => jobIdOfKind('flow')(v, p);
const proofJobR: Read<JobId> = (v, p) => jobIdOfKind('proof')(v, p);

/** The readers of the M4b facts, spread into `fact`. */
const FLOW_FACT_READERS: { readonly [K in FlowFactKind]: Read<Fact> } = {
  'flow-series': object((f): Fact => ({ kind: f.get('kind', literal('flow-series')), sha256: f.get('sha256', sha256R), highWater: f.get('highWater', positive) })),
  'flow-started': object((f): Fact => ({
    kind: f.get('kind', literal('flow-started')), job: f.get('job', flowJobR), triggers: f.get('triggers', flowTriggers), inputsSha256: f.get('inputsSha256', sha256R),
  })),
  'flow-ended': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('flow-ended')), job: f.get('job', flowJobR), outcome: f.get('outcome', oneOf(FLOW_OUTCOMES)),
      proposal: f.get('proposal', nullable(flowProposal)), dropped: f.get('dropped', nullable(flowDropped)), constraint: f.get('constraint', flowEndedConstraint),
    };
    const done = out.outcome === 'done';
    if (!done && (out.proposal !== null || out.dropped !== null)) throw new SchemaError(`${f.path}.proposal`, `none (nor a dropped one) for a run ${out.outcome}`, out.proposal ?? out.dropped);
    if (done !== (out.constraint.judged !== null)) throw new SchemaError(`${f.path}.constraint.judged`, done ? 'the role\'s reading of the constraint' : `null for a run ${out.outcome}`, out.constraint.judged);
    if (out.proposal !== null && out.dropped !== null) throw new SchemaError(`${f.path}.dropped`, 'null beside a surviving proposal', out.dropped);
    const id = out.proposal?.id ?? out.dropped?.proposal.id;
    if (id !== undefined && (proposalJob(id) !== out.job || id !== `${out.job}.0`)) throw new SchemaError(`${f.path}.proposal.id`, `${out.job}.0`, id);
    return out;
  }),
  'flow-requested': object((f): Fact => ({ kind: f.get('kind', literal('flow-requested')), command: f.get('command', cmdR), reason: f.get('reason', str) })),
  'flow-decided': object((f): Fact => ({
    kind: f.get('kind', literal('flow-decided')), proposal: f.get('proposal', proposalR), command: f.get('command', cmdR),
    decision: f.get('decision', oneOf(['accepted', 'rejected'] as const)), reason: f.get('reason', str),
  })),
  'flow-proof': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('flow-proof')), proposal: f.get('proposal', proposalR), job: f.get('job', proofJobR), treeSha: f.get('treeSha', shaR),
      oldSha256: f.get('oldSha256', nullable(sha256R)), newSha256: f.get('newSha256', nullable(sha256R)), outcome: f.get('outcome', oneOf(PROOF_OUTCOMES)),
      minutes: f.get('minutes', nullable(proofMinutes)), breaksStandIn: f.get('breaksStandIn', bool),
    };
    const compared = out.outcome === 'preserved' || out.outcome === 'changed';
    if (compared && (out.oldSha256 === null || out.newSha256 === null || out.minutes === null)) {
      throw new SchemaError(`${f.path}.minutes`, `both runs' records and minutes for a ${out.outcome} proof`, { oldSha256: out.oldSha256, newSha256: out.newSha256, minutes: out.minutes });
    }
    return out;
  }),
  'flow-applied': object((f): Fact => ({
    kind: f.get('kind', literal('flow-applied')), proposal: f.get('proposal', proposalR), revision: f.get('revision', planRevR), preimage: f.get('preimage', flowPreimage),
  })),
  'flow-verdict': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('flow-verdict')), proposal: f.get('proposal', proposalR), metric: f.get('metric', flowMetric), before: f.get('before', verdictBefore),
      after: f.get('after', verdictAfter), guards: f.get('guards', guardBreaches), verdict: f.get('verdict', oneOf(FLOW_VERDICTS)), preimage: f.get('preimage', flowPreimage),
    };
    if (out.guards.length > 0 && out.verdict !== 'worse') throw new SchemaError(`${f.path}.verdict`, 'worse (a guard was breached)', out.verdict);
    // Too few samples on either side (M4b B1 amendment: the before-window's too) is inconclusive, a breach aside.
    const few = Math.min(out.after.samples.length, out.before.samples.length) < MIN_VERDICT_SAMPLES;
    if (out.verdict === 'inconclusive' && !few) {
      throw new SchemaError(`${f.path}.verdict`, `conclusive with ${out.before.samples.length} samples before and ${out.after.samples.length} after (inconclusive below ${MIN_VERDICT_SAMPLES})`, out.verdict);
    }
    if (out.verdict !== 'inconclusive' && out.verdict !== 'worse' && few) {
      throw new SchemaError(`${f.path}.verdict`, `inconclusive with ${out.before.samples.length} samples before and ${out.after.samples.length} after`, out.verdict);
    }
    return out;
  }),
};

const walkJobR: Read<JobId> = (v, p) => jobIdOfKind('walk')(v, p);
const compareJobR: Read<JobId> = (v, p) => jobIdOfKind('compare')(v, p);
const milestoneR: Read<MilestoneId> = (v, p) => milestoneId(v, p);
const polishSet: Read<readonly PolishId[]> = idList((v, p): PolishId => polishId(v, p));
const ports: Read<Readonly<Record<ServeName, number>>> = (value, path) => {
  const f = new Fields(value, path);
  const out: Record<ServeName, number> = {};
  for (const key of Object.keys(value as object)) out[serveName(key, `${path}.${key}`)] = f.get(key, int(1, 65_535));
  f.end();
  return out;
};

/** The readers of the dev.13 facts, spread into `fact`. */
const WALK_FACT_READERS: { readonly [K in WalkFactKind]: Read<Fact> } = {
  'walk-started': object((f): Fact => ({
    kind: f.get('kind', literal('walk-started')), job: f.get('job', walkJobR), milestone: f.get('milestone', milestoneR), round: f.get('round', positive),
    sha: f.get('sha', shaR), ports: f.get('ports', ports),
  })),
  'walk-ended': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('walk-ended')), job: f.get('job', walkJobR), outcome: f.get('outcome', oneOf(WALK_OUTCOMES)), findings: f.get('findings', findingSet),
      proposals: f.get('proposals', polishSet), dropped: f.get('dropped', polishSet),
      ...(f.optional('interrupted', literal(true)) === undefined ? {} : { interrupted: true as const }),
    };
    if (out.interrupted === true && out.outcome !== 'abandoned') throw new SchemaError(`${f.path}.interrupted`, 'only on an abandoned walk', out.interrupted);
    if (out.outcome !== 'reported' && out.proposals.length > 0) throw new SchemaError(`${f.path}.proposals`, `none for a walk ${out.outcome}`, out.proposals);
    if (out.outcome === 'abandoned' && out.findings.length > 0) throw new SchemaError(`${f.path}.findings`, 'none for an abandoned walk', out.findings);
    if (out.outcome === 'bring-up-failed' && out.findings.length === 0) throw new SchemaError(`${f.path}.findings`, 'the P1 a failed bring-up opens', out.findings);
    const proposed = new Set<string>(out.proposals);
    out.dropped.forEach((id, i) => {
      if (!proposed.has(id)) throw new SchemaError(`${f.path}.dropped[${i}]`, 'a proposal of this walk', id);
    });
    return out;
  }),
  'polish-proposed': object((f): Fact => ({
    kind: f.get('kind', literal('polish-proposed')), id: f.get('id', (v, p): PolishId => polishId(v, p)), job: f.get('job', walkJobR), milestone: f.get('milestone', milestoneR),
    journey: f.get('journey', (v, p): JourneyId => journeyId(v, p)), evidence: f.get('evidence', arrayOf(str, { nonEmpty: true })), text: f.get('text', str),
    unit: f.get('unit', object((g): PolishUnitDraft => ({
      id: g.get('id', unitR), scope: g.get('scope', sortedBy((v, p): RepoPattern => repoPattern(v, p), (x) => x, { nonEmpty: true })), spec: g.get('spec', str),
    }))),
  })),
  'tweak-judged': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('tweak-judged')), unit: f.get('unit', unitR), decision: f.get('decision', oneOf(TWEAK_DECISIONS)), reason: f.get('reason', oneOf(TWEAK_REASONS)),
    };
    if (out.reason === 'reference-untouched' && out.decision !== 'drop') throw new SchemaError(`${f.path}.decision`, 'drop for a tweak that touched no reference', out.decision);
    return out;
  }),
  'polish-refused': object((f): Fact => ({
    kind: f.get('kind', literal('polish-refused')), proposal: f.get('proposal', (v, p): PolishId => polishId(v, p)), reasons: f.get('reasons', arrayOf(str, { nonEmpty: true })),
  })),
  'compare-started': object((f): Fact => ({
    kind: f.get('kind', literal('compare-started')), job: f.get('job', compareJobR), unit: f.get('unit', unitR), before: f.get('before', shaR), after: f.get('after', shaR),
    ports: f.get('ports', object((g) => ({ before: g.get('before', ports), after: g.get('after', ports) }))),
  })),
  'compare-abandoned': object((f): Fact => ({
    kind: f.get('kind', literal('compare-abandoned')), job: f.get('job', compareJobR), detail: f.get('detail', str),
    ...(f.optional('interrupted', literal(true)) === undefined ? {} : { interrupted: true as const }),
  })),
  'milestone-passed': object((f): Fact => ({ kind: f.get('kind', literal('milestone-passed')), milestone: f.get('milestone', milestoneR), job: f.get('job', walkJobR) })),
  'demo-promoted': object((f): Fact => ({ kind: f.get('kind', literal('demo-promoted')), milestone: f.get('milestone', milestoneR), sha: f.get('sha', shaR) })),
  'demo-failed': object((f): Fact => ({ kind: f.get('kind', literal('demo-failed')), milestone: f.get('milestone', milestoneR), sha: f.get('sha', shaR), log: f.get('log', absR) })),
  'demo-acted': object((f): Fact => ({ kind: f.get('kind', literal('demo-acted')), command: f.get('command', cmdR), act: f.get('act', oneOf(DEMO_ACTS)) })),
};

/** The readers of the M3 facts, spread into `fact`. */
const HOLISTIC_FACT_READERS: { readonly [K in HolisticFactKind]: Read<Fact> } = {
  witnessed: object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('witnessed')), lane: f.get('lane', laneR), laneRev: f.get('laneRev', laneRevR), envId: f.get('envId', (v, p): EnvId => envId(v, p)),
      treeSha: f.get('treeSha', shaR), inv: f.get('inv', invR), recordsSha256: f.get('recordsSha256', sha256R), purpose: f.get('purpose', oneOf(WITNESS_PURPOSES)),
      for: f.get('for', witnessFor),
    };
    // G13: a mutant run (a finding's, or M4a rev 3's mutation smoke) is recorded as such and never certifies.
    const mutant = out.for.type === 'mutant' || out.for.type === 'smoke';
    if ((out.purpose === 'mutant') !== mutant) throw new SchemaError(`${f.path}.for`, out.purpose === 'mutant' ? 'mutant{finding, of} or smoke{unit, attempt, of}' : 'a candidate or a job', out.for);
    return out;
  }),
  'obligation-latched': object((f): Fact => ({
    kind: f.get('kind', literal('obligation-latched')), obligation: f.get('obligation', obligationR), unit: f.get('unit', unitR), treeSha: f.get('treeSha', shaR),
  })),
  'finding-opened': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('finding-opened')), id: f.get('id', findingR), key: f.get('key', sha256R), lens: f.get('lens', oneOf(FINDING_LENSES)),
      severity: f.get('severity', oneOf(FINDING_SEVERITIES)), obligation: f.get('obligation', nullable(obligationR)),
      visionClauses: f.get('visionClauses', idList((v, p): VisionClauseId => visionClauseId(v, p), { legacyStringOrder: true })), claim: f.get('claim', str),
      evidence: f.get('evidence', arrayOf(findingEvidence)), mutant: f.get('mutant', nullable(mutantRef)), source: f.get('source', findingSource),
      gateHadPassed: f.get('gateHadPassed', bool),
    };
    const milestone = f.optional('milestone', (v, p): MilestoneId => milestoneId(v, p));
    const cause = f.optional('cause', str);
    // dev.13: a walkthrough finding names its milestone, is a P1 (breaks) or a P2 (deviates), and comes from a walk job or
    // the demo; no other finding names a milestone or comes from the demo.
    const walk = out.lens === 'walkthrough';
    if (walk !== (milestone !== undefined)) throw new SchemaError(`${f.path}.milestone`, walk ? 'the milestone of a walkthrough finding' : 'absent (only a walkthrough finding names one)', milestone);
    if (cause !== undefined && !walk) throw new SchemaError(`${f.path}.cause`, 'absent (only a walkthrough finding keeps its cause)', cause);
    if (walk && out.severity === 'P3') throw new SchemaError(`${f.path}.severity`, 'P1 or P2 for a walkthrough finding', out.severity);
    if (out.source.type === 'demo' && !(walk && out.severity === 'P1')) throw new SchemaError(`${f.path}.source`, 'a walk job (only a walkthrough P1 comes from the demo)', out.source);
    if (walk && out.source.type === 'job' && parseJobId(out.source.job).kind !== 'walk') throw new SchemaError(`${f.path}.source.job`, 'a walk-<n> job', out.source.job);
    if (out.mutant !== null && out.lens !== 'vacuity') throw new SchemaError(`${f.path}.mutant`, 'null except for a vacuity finding', out.mutant);
    // R17: plan-check opens only P3 vision-conflict findings, from its own attempt; every other opener is a job.
    if ((out.lens === 'plan-check') !== (out.source.type === 'stage')) throw new SchemaError(`${f.path}.source`, out.lens === 'plan-check' ? 'the plan-check attempt' : 'the job that opened it', out.source);
    if (out.lens === 'plan-check' && (out.severity !== 'P3' || out.visionClauses.length === 0)) throw new SchemaError(`${f.path}.severity`, 'P3 citing vision clauses for a plan-check vision conflict', out.severity);
    // A must-hold not held on an audit snapshot opens a P1 over its obligation.
    if (out.lens === 'witness' && (out.severity !== 'P1' || out.obligation === null)) throw new SchemaError(`${f.path}.severity`, 'P1 over its obligation for a witness finding', out.severity);
    if (out.lens === 'vision' && out.severity === 'P1') throw new SchemaError(`${f.path}.severity`, 'P2 or P3 for a vision-lens finding', out.severity);
    // M4a: a checkpoint's issue intake opens P2 or P3 only.
    if (out.lens === 'issue' && out.severity === 'P1') throw new SchemaError(`${f.path}.severity`, 'P2 or P3 for an issue finding', out.severity);
    return { ...out, ...(milestone === undefined ? {} : { milestone }), ...(cause === undefined ? {} : { cause }) };
  }),
  'finding-transition': object((f): Fact => ({ kind: f.get('kind', literal('finding-transition')), id: f.get('id', findingR), to: f.get('to', findingTo) })),
  'audit-started': object((f): Fact => {
    const diffBudget = f.optional('diffBudget', positive);
    return {
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
      ...(diffBudget === undefined ? {} : { diffBudget }),
    };
  }),
  'audit-ended': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('audit-ended')),
      job: f.get('job', auditJobR),
      covered: f.get('covered', sortedBy(object((g) => ({ lens: g.get('lens', lensR), from: g.get('from', shaR), to: g.get('to', shaR) })), (c) => c.lens)),
      findings: f.get('findings', findingSet),
      suppressed: f.get('suppressed', nat),
      outcome: f.get('outcome', oneOf(['completed', 'abandoned'] as const)),
    };
    const refused = f.optional('refused', arrayOf(object((g): LensRefusal => ({
      lens: g.get('lens', lensR), attempt: g.get('attempt', positive), claim: g.get('claim', str), cause: g.get('cause', str), reason: g.get('reason', str),
    }))));
    return { ...out, ...(refused === undefined ? {} : { refused }) };
  }),
  'docs-covered': object((f): Fact => ({ kind: f.get('kind', literal('docs-covered')), pub: f.get('pub', docsJobR), from: f.get('from', shaR), to: f.get('to', shaR) })),
  'checkpoint-inputs': object((f): Fact => {
    const out = {
      kind: f.get('kind', literal('checkpoint-inputs')), job: f.get('job', ckptJobR), trigger: f.get('trigger', checkpointTrigger),
      generation: f.get('generation', positive), vector: f.get('vector', revisionVector), headSha: f.get('headSha', shaR), visionSha256: f.get('visionSha256', sha256R),
      findings: f.get('findings', findingSet),
      observations: f.get('observations', sortedBy(observationKey, (k: ObservationKey) => `${k.treeSha}/${k.lane}/${k.laneRev}/${k.envId}`)),
    };
    if (out.vector.visionSha256 !== out.visionSha256) throw new SchemaError(`${f.path}.vector.visionSha256`, out.visionSha256, out.vector.visionSha256);
    const issues = f.optional('issues', checkpointIssues);
    const corpusSha256 = f.optional('corpusSha256', sha256R);
    return { ...out, ...(issues === undefined ? {} : { issues }), ...(corpusSha256 === undefined ? {} : { corpusSha256 }) };
  }),
  'bundle-decided': object((f): Fact => ({ kind: f.get('kind', literal('bundle-decided')), job: f.get('job', ckptJobR), outcome: f.get('outcome', bundleOutcome) })),
  'checkpoint-skipped': object((f): Fact => ({
    kind: f.get('kind', literal('checkpoint-skipped')), audit: f.get('audit', auditJobR), generation: f.get('generation', positive), visionSha256: f.get('visionSha256', sha256R),
    carried: f.get('carried', findingSet),
  })),
  divergence: object((f): Fact => ({ kind: f.get('kind', literal('divergence')), id: f.get('id', (v, p): DivergenceId => divergenceId(v, p)), index: f.get('index', nat), ...divergenceDraftFields(f) })),
  'divergence-digest': object((f): Fact => ({
    kind: f.get('kind', literal('divergence-digest')), needsUser: f.get('needsUser', (v, p): NeedsUserId => needsUserId(v, p)),
    ids: f.get('ids', idList((v, p): DivergenceId => divergenceId(v, p), { nonEmpty: true, legacyStringOrder: true })),
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
  meter: object((f): Fact => {
    const session = f.optional('session', (v, p) => claudeSessionId(v, p));
    const delegated = f.optional('delegated', classUsages);
    if ((session === undefined) !== (delegated === undefined)) throw new SchemaError(f.path, 'session and delegated together, or neither', { session, delegated });
    return {
      kind: f.get('kind', literal('meter')), inv: f.get('inv', invR), routingRev: f.get('routingRev', revR), subject: f.get('subject', meterSubject),
      usage: f.get('usage', tokenUsage), ...(session === undefined || delegated === undefined ? {} : { session, delegated }),
    };
  }),
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
  'scope-decided': object((f): Fact => ({
    kind: f.get('kind', literal('scope-decided')), unit: f.get('unit', unitR), attempt: f.get('attempt', positive), command: f.get('command', cmdR),
    decision: f.get('decision', oneOf(['accepted', 'rejected'] as const)), reason: f.get('reason', str),
  })),
  reopened: object((f): Fact => ({
    kind: f.get('kind', literal('reopened')), unit: f.get('unit', unitR), command: f.get('command', nullable(cmdR)), specRev: f.get('specRev', specRevR),
    specSha256: f.get('specSha256', sha256R),
  })),
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
    if ((fingerprint !== undefined) !== (out.stage === 'gate')) throw new SchemaError(`${f.path}.fingerprint`, out.stage === 'gate' ? 'the gate\'s approval fingerprint' : 'absent on a plan-check', fingerprint);
    const paths = sortedBy((v, p) => repoPath(v, p), (x) => x);
    const diffShown = f.optional('diffShown', object((g): DiffShown => ({ inlined: g.get('inlined', paths), notInlined: g.get('notInlined', paths) })));
    if (diffShown !== undefined && out.stage !== 'gate') throw new SchemaError(`${f.path}.diffShown`, 'absent on a plan-check', diffShown);
    const largeDiff = f.optional('largeDiff', nullable(object((g): GateLargeDiff => ({ overflow: g.get('overflow', positive) }))));
    if (largeDiff !== undefined && out.stage !== 'gate') throw new SchemaError(`${f.path}.largeDiff`, 'absent on a plan-check', largeDiff);
    if (fingerprint === undefined) return out;
    if (fingerprint.unitCommit !== out.head) throw new SchemaError(`${f.path}.fingerprint.unitCommit`, `the head the gate read (${out.head})`, fingerprint.unitCommit);
    return { ...out, fingerprint, ...(diffShown === undefined ? {} : { diffShown }), ...(largeDiff === undefined ? {} : { largeDiff }) };
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
    const opt: Record<string, unknown> = {};
    for (const [key, read] of [['obligationsSha256', sha256R], ['visionSha256', sha256R], ['publication', object((g) => ({ pub: g.get('pub', docsJobR), head: g.get('head', shaR) }))]] as const) {
      const v = f.optional(key, read as Read<unknown>);
      if (v !== undefined) opt[key] = v;
    }
    const out = {
      kind: f.get('kind', literal('plan-applied')), rev: f.get('rev', (v, p) => planRev(v, p)), command: f.get('command', nullable(cmdR)),
      planSha256: f.get('planSha256', sha256R), specs: f.get('specs', manifestSpecs), changes: f.get('changes', arrayOf(planChange)),
      ...(scheduling === undefined ? {} : { scheduling }),
      source: f.get('source', revisionSource), payloadSha256: f.get('payloadSha256', sha256R), rulingsSha256: f.get('rulingsSha256', sha256R),
      routingProvenance: f.get('routingProvenance', routingProvenance), ...opt,
    };
    if ((scheduling !== undefined) !== (out.rev === 1)) throw new SchemaError(`${f.path}.scheduling`, out.rev === 1 ? 'dag on rev 1' : 'absent after rev 1 (the arc\'s scheduling is fixed at its first plan)', scheduling);
    if (out.source.type === 'command' ? out.source.command !== out.command : out.command !== null) {
      throw new SchemaError(`${f.path}.source`, `the source naming command ${out.command}`, out.source);
    }
    if (opt['obligationsSha256'] !== undefined && opt['visionSha256'] === undefined) throw new SchemaError(`${f.path}.obligationsSha256`, 'absent without a vision (obligations are a holistic input, A5)', opt['obligationsSha256']);
    return out as Fact;
  }),
  'executor-started': object((f): Fact => {
    const host = f.optional('host', hostFingerprint);
    const pressure = f.optional('pressure', oneOf(PRESSURE_AVAILABILITIES));
    return {
      kind: f.get('kind', literal('executor-started')), generation: f.get('generation', positive), ...(host === undefined ? {} : { host }),
      ...(pressure === undefined ? {} : { pressure }),
    };
  }),
  approval: object((f): Fact => ({
    kind: f.get('kind', literal('approval')), unit: f.get('unit', unitR), attempt: f.get('attempt', positive), fingerprint: f.get('fingerprint', approvalFingerprint),
  })),
  ...HOLISTIC_FACT_READERS,
  ...M4A_FACT_READERS,
  ...FLOW_FACT_READERS,
  ...WALK_FACT_READERS,
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
    const detail = f.optional('detail', stageOutcomeDetail);
    const wants = (DETAILED_OUTCOMES as Readonly<Record<string, StageOutcomeDetail['kind']>>)[`${s}/${out.outcome}`];
    if (detail?.kind !== wants) throw new SchemaError(`${f.path}.detail`, wants === undefined ? 'absent (this outcome carries no detail)' : `a ${wants} detail`, detail);
    if (park !== undefined && out.class !== 'park') throw new SchemaError(`${f.path}.park`, 'absent unless the class is park', park);
    if (cause !== undefined && out.class !== 'hold') throw new SchemaError(`${f.path}.cause`, 'absent unless the class is hold', cause);
    // The chargeable bound is a design park: the unit needs a spec revision or a re-entry.
    if (park !== undefined && out.chargeable && !(park.class === 'operator' && park.kind === 'design')) throw new SchemaError(`${f.path}.park`, 'operator design for the chargeable bound', park);
    // The fold keys retries and route-ups by stage, so those classes only exist where the stage has them.
    if (out.class === 'retry' && !(RETRY_STAGES as readonly string[]).includes(s)) throw new SchemaError(`${f.path}.class`, `retry only at ${RETRY_STAGES.join(', ')}`, out.class);
    if (out.class === 'route-up' && !(JUDGMENT_STAGES as readonly string[]).includes(s)) throw new SchemaError(`${f.path}.class`, `route-up only at ${JUDGMENT_STAGES.join(', ')}`, out.class);
    // An interruption holds the unit, and so does a scope-growth proposal (a plan-check's, or a lanes attempt's after two
    // reverts of one path); nothing else does; a hold never charges.
    const holds = out.outcome === 'interrupted' || ((s === 'plan-check' || s === 'lanes') && out.outcome === 'scope-growth');
    if (holds !== (out.class === 'hold')) throw new SchemaError(`${f.path}.class`, 'hold exactly for an interrupted outcome or a scope-growth', out.class);
    if (out.class === 'hold' && out.chargeable) throw new SchemaError(`${f.path}.chargeable`, 'false for a hold', out.chargeable);
    return { ...out, ...(park === undefined ? {} : { park }), ...(cause === undefined ? {} : { cause }), ...(detail === undefined ? {} : { detail }) } as StageOutcomeFact;
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
