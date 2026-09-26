// The event log (`events.jsonl`) record types, their validators, canonical serialisation and the chain
// hash rule. The journal (append, tail, fold) is step 2 and builds on these. SCHEMAS.md "Event log" is the
// prose twin of this module.
import type { Buffer } from 'node:buffer';
import {
  type ArcId, type CommandId, type InvocationId, type LaneId, type NeedsUserId, type OpId, type OpKey, type ResourceName,
  type RoutingRev, type Sha, type Sha256Hex, type SpecRev, type UnitId, INTEGRATION_SLOT, arcId, commandId,
  invocationIdOf, laneId, needsUserId, opIdOf, opKey, parseOpId, resourceName, routingRev, sha, sha256, specRev, unitId,
} from './ids.ts';
import { canonicalJson, sha256Hex } from './json.ts';
import {
  COMMAND_VERDICTS, type ApprovalFingerprint, type BackendOutcomeKind, type CommandVerdict, type ContainmentMode, type DispatchRecord,
  type KillReason, type PauseTarget, type ResidueRecord, type ResumeTarget, type SpecPatch, type Stage, type TokenUsage,
  type UsageUnavailableReason, approvalFingerprint, containmentMode, dispatchRecord, killReason, optionId, pauseTarget,
  resumeTarget, specPatch, stage, tokenUsage, usageUnavailableReason,
} from './records.ts';
import {
  type Read, Fields, SchemaError, arrayOf, bool, literal, nat, nullable, object, oneOf, positive, str, tagged, text,
  version,
} from './validate.ts';
import {
  type AbsPath, type GitDate, type IsoTime, type RefName, type RepoPath, type RepoPattern, absPath, gitDate, isoTime,
  refName, repoPath, repoPattern,
} from './values.ts';
import type { SchemaVersion } from './version.ts';
import { type Backend, type SeatRef, backend, seatFields } from '../routing/types.ts';

// ---------------------------------------------------------------------------------------------------
// Op kinds and their payloads

export const OP_KINDS = [
  'worktree.create', 'worktree.remove', 'resource.transition', 'proc.spawn', 'proc.kill', 'evidence.snapshot',
  'salvage.commit', 'mergein.prepare', 'spec.patch', 'candidate.merge', 'integration.ff', 'snapshot.publish',
  'needsuser.raise', 'command.apply',
] as const;
export type OpKind = (typeof OP_KINDS)[number];
export const GIT_OP_KINDS = [
  'worktree.create', 'worktree.remove', 'salvage.commit', 'mergein.prepare', 'candidate.merge', 'integration.ff',
  'snapshot.publish',
] as const satisfies readonly OpKind[];
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

/** Who holds a reservation: a unit's stage attempt, or a sweep command. */
export type Holder =
  | Readonly<{ type: 'stage'; unit: UnitId; stage: Stage; attempt: number }>
  | Readonly<{ type: 'sweep'; command: CommandId }>;

/**
 * The legal reservation edges: free→reserved, reserved→running, reserved|running→cleaning, cleaning→free,
 * cleaning→cleanup-failed, and `reclaim`: cleanup-failed→cleaning, taken only by a sweep holder sweeping
 * that resource's residue (the stage holder is gone; the sweep re-runs the recorded teardown). A `fail`
 * lists one residue per failed resource (exactly the transitioned set).
 */
export type ResourceEdge =
  | Readonly<{ type: 'reserve' }>
  | Readonly<{ type: 'reclaim' }>
  | Readonly<{ type: 'run' }>
  | Readonly<{ type: 'clean'; from: 'reserved' | 'running' }>
  | Readonly<{ type: 'release' }>
  | Readonly<{ type: 'fail'; residues: readonly Readonly<{ resource: ResourceName; teardown: InvocationId }>[] }>;

/** What a spawn runs. Model ids never appear: a backend is named by role and routingRev. */
export type SpawnSubject =
  | (Readonly<{ purpose: 'backend'; routingRev: RoutingRev; unit: UnitId; attempt: number }> & SeatRef)
  | Readonly<{ purpose: 'lane'; unit: UnitId; lane: LaneId; set: 'spec' | 'suite'; at: Sha }>
  | Readonly<{ purpose: 'teardown' | 'probe'; unit: UnitId | null; resource: ResourceName }>
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
  /** `resources` in lock order: ascending, `integration-slot` last. */
  'resource.transition': Readonly<{ holder: Holder; resources: readonly ResourceName[]; edge: ResourceEdge }>;
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
  }>;
  'integration.ff': Readonly<{ ref: RefName; old: Sha; new: Sha; fingerprint: ApprovalFingerprint }>;
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
};

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
};

// ---------------------------------------------------------------------------------------------------
// Records and envelope

export type Parent =
  | Readonly<{ type: 'stage'; unit: UnitId; stage: Stage; attempt: number }>
  | Readonly<{ type: 'command'; command: CommandId }>
  | Readonly<{ type: 'op'; op: OpId }>
  | Readonly<{ type: 'arc' }>;

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
  | (Readonly<{ type: 'seat'; unit: UnitId; attempt: number }> & SeatRef)
  | Readonly<{ type: 'smoke'; backend: Backend }>;

// ---------------------------------------------------------------------------------------------------
// Stage outcomes: the vocabulary of the `stage-outcome` fact. The transition table itself (what each
// outcome leads to) is `src/pipeline/transitions.ts`; its `StageOutcome` union is derived from this list.

/** Every outcome a stage can report, per stage. `retire` is terminal and reports none. */
export const STAGE_OUTCOME_KINDS = {
  'plan-check': ['approve', 'redirect', 'infeasible', 'escalate', 'risk-lowered', 'scope-widened', 'refusal', 'malformed', 'process-fault', 'interrupted', 'routing-changed'],
  build: ['success', 'refusal', 'malformed', 'process-fault', 'lost', 'lost-tree-effects', 'occupied', 'cleanup-failed', 'interrupted', 'routing-changed'],
  quiesce: ['empty'],
  evidence: ['captured'],
  salvage: ['committed', 'committed-contract-touched', 'unmerged', 'commit-failed'],
  teardown: ['released', 'cleanup-failed'],
  lanes: ['green', 'red', 'not-certified', 'blocked', 'interrupted', 'occupied', 'cleanup-failed'],
  gate: ['approve', 'revise', 'escalate', 'empty-diff', 'refusal', 'malformed', 'process-fault', 'interrupted', 'routing-changed'],
  candidate: ['green', 'transient-violation', 'conflict', 'red', 'base-red', 'blocked', 'occupied', 'cleanup-failed', 'interrupted'],
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
 * One per (unit, stage, attempt). `chargeable` marks a design-class failure (the table's C rows); the
 * third one bounds the unit, so its class must be `park`.
 */
export type StageOutcomeFact = { [S in OutcomeStage]: Readonly<{
  kind: 'stage-outcome';
  unit: UnitId;
  stage: S;
  attempt: number;
  outcome: StageOutcomeKind<S>;
  class: OutcomeClass;
  chargeable: boolean;
}> }[OutcomeStage];

export type Fact =
  | Readonly<{ kind: 'tail-discarded'; offset: number; length: number; sha256: Sha256Hex }>
  | Readonly<{ kind: 'containment-mode'; mode: ContainmentMode }>
  /** One usage fact per invocation, charged to `subject`. */
  | Readonly<{ kind: 'meter'; inv: InvocationId; routingRev: RoutingRev; subject: MeterSubject; usage: TokenUsage }>
  | Readonly<{ kind: 'usage-unavailable'; inv: InvocationId; routingRev: RoutingRev; subject: MeterSubject; reason: UsageUnavailableReason }>
  | Readonly<{ kind: 'dispatch'; record: DispatchRecord }>
  /**
   * A backend reported a usage-limit or capacity error on a failed invocation: it is parked arc-wide until
   * the architect resumes it (`resume --backend`, which re-runs its smoke first). `inv` is the invocation
   * whose result carried the error.
   */
  | Readonly<{ kind: 'backend-park'; backend: Backend; class: BackendParkClass; inv: InvocationId }>
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
   * `resume <unit>` re-opened a unit parked at a judgment stage after the architect edited its spec: the
   * file is at `specRev` (the unit's recorded spec rev + 1) with bytes hashing to `specSha256`. The unit
   * re-enters at plan-check as a new attempt; its counters are kept, and the redirect bound counts from here.
   */
  | Readonly<{ kind: 'reopened'; unit: UnitId; command: CommandId; specRev: SpecRev; specSha256: Sha256Hex }>
  /**
   * `resume <unit>` re-entered a unit parked `routing-changed` once the routing in force lets it keep its
   * implementer seat (a `dispatch` fact re-pinned it first). The unit re-enters at the stage it parked at as
   * a new, uncharged attempt: its decision and interruption return to what they were before the park.
   */
  | Readonly<{ kind: 'rerouted'; unit: UnitId; command: CommandId }>
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
  | StageOutcomeFact;
export type FactRecord = Readonly<{ type: 'fact'; fact: Fact }>;

/** The backend error classes that park a backend arc-wide (lead ruling, 11b). */
export const BACKEND_PARK_CLASSES = ['usage-limit', 'capacity'] as const;
export type BackendParkClass = (typeof BACKEND_PARK_CLASSES)[number];

export type LogRecord = IntentRecord | DoneRecord | AbortRecord | FactRecord;

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

/** Lock order: strictly ascending, except `integration-slot`, which, when present, is last. */
const lockOrder: Read<readonly ResourceName[]> = (value, path) => {
  const list = arrayOf(resR, { nonEmpty: true })(value, path);
  const slot = list.indexOf(INTEGRATION_SLOT);
  if (slot !== -1 && slot !== list.length - 1) throw new SchemaError(path, 'integration-slot last', value);
  const rest = slot === -1 ? list : list.slice(0, -1);
  for (let i = 1; i < rest.length; i++) {
    if (!((rest[i - 1] as string) < (rest[i] as string))) throw new SchemaError(`${path}[${i}]`, 'ascending names, no duplicates', value);
  }
  return list;
};

const holder: Read<Holder> = tagged('type', {
  stage: object((f): Holder => ({ type: f.get('type', literal('stage')), unit: f.get('unit', unitR), stage: f.get('stage', stage), attempt: f.get('attempt', positive) })),
  sweep: object((f): Holder => ({ type: f.get('type', literal('sweep')), command: f.get('command', cmdR) })),
});

const resourceEdge: Read<ResourceEdge> = tagged('type', {
  reserve: object((f): ResourceEdge => ({ type: f.get('type', literal('reserve')) })),
  reclaim: object((f): ResourceEdge => ({ type: f.get('type', literal('reclaim')) })),
  run: object((f): ResourceEdge => ({ type: f.get('type', literal('run')) })),
  clean: object((f): ResourceEdge => ({ type: f.get('type', literal('clean')), from: f.get('from', oneOf(['reserved', 'running'] as const)) })),
  release: object((f): ResourceEdge => ({ type: f.get('type', literal('release')) })),
  fail: object((f): ResourceEdge => ({
    type: f.get('type', literal('fail')),
    residues: f.get('residues', arrayOf(object((g) => ({ resource: g.get('resource', resR), teardown: g.get('teardown', invR) })), { nonEmpty: true })),
  })),
});

const spawnSubject: Read<SpawnSubject> = tagged('purpose', {
  backend: object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('backend')), ...seatFields(f), routingRev: f.get('routingRev', revR),
    unit: f.get('unit', unitR), attempt: f.get('attempt', positive),
  })),
  lane: object((f): SpawnSubject => ({
    purpose: f.get('purpose', literal('lane')), unit: f.get('unit', unitR), lane: f.get('lane', (v, p): LaneId => laneId(v, p)),
    set: f.get('set', oneOf(['spec', 'suite'] as const)), at: f.get('at', shaR),
  })),
  teardown: object((f): SpawnSubject => ({ purpose: f.get('purpose', literal('teardown')), unit: f.get('unit', nullable(unitR)), resource: f.get('resource', resR) })),
  probe: object((f): SpawnSubject => ({ purpose: f.get('purpose', literal('probe')), unit: f.get('unit', nullable(unitR)), resource: f.get('resource', resR) })),
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
      if (e.edge.type === 'reclaim' && e.holder.type !== 'sweep') throw new SchemaError(`${path}.expect.holder.type`, 'sweep (only a sweep reclaims a cleanup-failed resource)', e.holder.type);
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
    expect: object((f) => ({
      ref: f.get('ref', refR),
      old: f.get('old', nullable(shaR)),
      integrationTip: f.get('integrationTip', shaR),
      unitCommit: f.get('unitCommit', shaR),
      worktree: f.get('worktree', absR),
      commit: f.get('commit', commitInputs<readonly [Sha, Sha]>([2])),
    })),
    post: object((f) => ({ new: f.get('new', shaR) })),
    outcome: kindOnly('merged'),
    check: (e, _post, path) => {
      if (!/^refs\/roadmap-run\/[^/]+\/candidate\/[^/]+$/.test(e.ref)) throw new SchemaError(`${path}.expect.ref`, 'refs/roadmap-run/<arc>/candidate/<unit>', e.ref);
      sameList(e.commit.parents, [e.integrationTip, e.unitCommit], `${path}.expect.commit.parents`);
    },
  },
  'integration.ff': {
    expect: object((f) => ({ ref: f.get('ref', refR), old: f.get('old', shaR), new: f.get('new', shaR), fingerprint: f.get('fingerprint', approvalFingerprint) })),
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
};

const parent: Read<Parent> = tagged('type', {
  stage: object((f): Parent => ({ type: f.get('type', literal('stage')), unit: f.get('unit', unitR), stage: f.get('stage', stage), attempt: f.get('attempt', positive) })),
  command: object((f): Parent => ({ type: f.get('type', literal('command')), command: f.get('command', cmdR) })),
  op: object((f): Parent => ({ type: f.get('type', literal('op')), op: f.get('op', opR) })),
  arc: object((f): Parent => ({ type: f.get('type', literal('arc')) })),
});

const meterSubject: Read<MeterSubject> = tagged('type', {
  seat: object((f): MeterSubject => ({
    type: f.get('type', literal('seat')), ...seatFields(f), unit: f.get('unit', unitR), attempt: f.get('attempt', positive),
  })),
  smoke: object((f): MeterSubject => ({ type: f.get('type', literal('smoke')), backend: f.get('backend', backend) })),
});

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
  'backend-park': object((f): Fact => ({
    kind: f.get('kind', literal('backend-park')), backend: f.get('backend', backend), class: f.get('class', oneOf(BACKEND_PARK_CLASSES)), inv: f.get('inv', invR),
  })),
  'needs-user-acked': object((f): Fact => ({
    kind: f.get('kind', literal('needs-user-acked')), id: f.get('id', (v, p): NeedsUserId => needsUserId(v, p)), command: f.get('command', cmdR),
    choice: f.get('choice', nullable(optionId)),
  })),
  paused: object((f): Fact => ({ kind: f.get('kind', literal('paused')), command: f.get('command', cmdR), target: f.get('target', pauseTarget) })),
  'stop-requested': object((f): Fact => ({ kind: f.get('kind', literal('stop-requested')), command: f.get('command', cmdR) })),
  resumed: object((f): Fact => ({ kind: f.get('kind', literal('resumed')), command: f.get('command', cmdR), target: f.get('target', resumeTarget) })),
  reopened: object((f): Fact => ({
    kind: f.get('kind', literal('reopened')), unit: f.get('unit', unitR), command: f.get('command', cmdR), specRev: f.get('specRev', specRevR),
    specSha256: f.get('specSha256', sha256R),
  })),
  rerouted: object((f): Fact => ({ kind: f.get('kind', literal('rerouted')), unit: f.get('unit', unitR), command: f.get('command', cmdR) })),
  'executor-started': object((f): Fact => ({ kind: f.get('kind', literal('executor-started')), generation: f.get('generation', positive) })),
  approval: object((f): Fact => ({
    kind: f.get('kind', literal('approval')), unit: f.get('unit', unitR), attempt: f.get('attempt', positive), fingerprint: f.get('fingerprint', approvalFingerprint),
  })),
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
    // The fold keys retries and route-ups by stage, so those classes only exist where the stage has them.
    if (out.class === 'retry' && !(RETRY_STAGES as readonly string[]).includes(s)) throw new SchemaError(`${f.path}.class`, `retry only at ${RETRY_STAGES.join(', ')}`, out.class);
    if (out.class === 'route-up' && !(JUDGMENT_STAGES as readonly string[]).includes(s)) throw new SchemaError(`${f.path}.class`, `route-up only at ${JUDGMENT_STAGES.join(', ')}`, out.class);
    // An interruption holds the unit, and nothing else does; a hold never charges.
    if ((out.outcome === 'interrupted') !== (out.class === 'hold')) throw new SchemaError(`${f.path}.class`, 'hold exactly for an interrupted outcome', out.class);
    if (out.class === 'hold' && out.chargeable) throw new SchemaError(`${f.path}.chargeable`, 'false for a hold', out.chargeable);
    return out;
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
