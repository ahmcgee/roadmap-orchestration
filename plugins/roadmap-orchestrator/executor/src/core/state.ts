// The fold: the one derivation of run state from the event log. Everything the executor knows about ops,
// units, spend and needs-user comes from folding events.jsonl in order; `state.json` is a cache of the
// result for humans and tools, and nothing reads it back for a decision.
//
// The fold also enforces the log's invariants (SCHEMAS.md "Event log"): a violation throws
// FoldInvariantError. At open the journal turns that into a refusal (`log-corrupt`); at append it means
// the caller asked for an illegal record, and nothing is written.
import {
  type AbortRecord, type AuditInputs, type BackendParkClass, type CoveredRange, type DoneRecord, type Event, type Fact, type HolisticFact, type Holder,
  type IntentOf, type IntentRecord, type JudgmentInputs, type JudgmentStage, type OpKind, type ParkRecord, type PlanAppliedFact, type ProbeTarget,
  type ResourceEdge, type RetryStage, type StageOutcomeFact, JUDGMENT_STAGES, RECLAIM_HOLDERS, RESIDUE_HOLDERS, RETRY_STAGES, RETRYABLE_BACKEND_PARKS,
  prevHash, probeTargetKey, serializeEvent,
} from './events.ts';
import { atomicJson, monotonic } from './fsx.ts';
import {
  type AmendmentId, type ArcId, type CommandId, type DivergenceId, type EdgeId, type FindingId, type InvocationId, type JobId, type JobKind, type NeedsUserId, type ObligationId,
  type OpId, type OpKey, type PlanRev, type ResourceInstance, type ResourceUnit, type RoutingRev, type Sha, type Sha256Hex, type SpecRev, type UnitId,
  JOB_KINDS, amendmentIdOf, compareResourceUnits, divergenceIdOf, findingIdOf, jobId, parseInvocationId, parseJobId, parseOpId,
} from './ids.ts';
import type { ControlState, JournalView, NeedsUserAckState, NeedsUserState } from './interfaces.ts';
import { canonicalJson } from './json.ts';
import { type ApprovalFingerprint, type Bounds, type ContainmentMode, type DispatchRecord, type ResidueKey, type Stage, DEFAULT_BOUNDS, boundsOfRecord } from './records.ts';
import { type BundleOutcome, type FindingStateName, type FindingTo, FINDING_MOVES } from '../holistic/types.ts';
import type { IsoTime } from './values.ts';
import { SCHEMA_VERSION, type SchemaVersion } from './version.ts';
import { type Backend, RISK_TIERS, type RiskTier, type Role } from '../routing/types.ts';

export class FoldInvariantError extends Error {
  readonly seq: number;
  readonly detail: string;
  constructor(seq: number, detail: string) {
    super(`event seq ${seq}: ${detail}`);
    this.name = 'FoldInvariantError';
    this.seq = seq;
    this.detail = detail;
  }
}

export type TailDiscarded = Extract<Fact, { kind: 'tail-discarded' }>;

/** The third chargeable (design-class) failure parks the unit, unless its `limits` say otherwise (M3). */
export const CHARGEABLE_BOUND = DEFAULT_BOUNDS.chargeable;

/** Cumulative per-unit counters, all `monotonic()`. */
export type UnitCounters = Readonly<{
  /** Stage starts: distinct (stage, attempt) pairs named by a stage-parented intent or a stage-outcome fact. */
  attempts: number;
  chargeableFailures: number;
  /** Plan-check redirects applied. */
  redirects: number;
  /** Gate revise rounds taken. */
  reviseRounds: number;
  /** Red candidates sent back to a fix round. */
  candidateReds: number;
  /** Uncharged retries taken, per stage. */
  retries: Readonly<Record<RetryStage, number>>;
}>;

/**
 * The latest decision's effect: `park-pending` and `stop-pending` mean a needs-user is due (or raised);
 * `held` means the stage was interrupted and waits for a resume. M2: `cut` (a `unit-cut` plan change: out of
 * scope for good) and `superseded` (a `unit-reentered` change: its lineage continues in `supersededBy`).
 */
export type UnitStatus = 'active' | 'held' | 'park-pending' | 'stop-pending' | 'retired' | 'cut' | 'superseded';

/**
 * A parked unit's park (M2): the seq and time of the `stage-outcome` fact that parked it (probes cover the
 * seq), its class as recorded (or the interim M2 shim's operator reading), and the retryable targets a covering probe has passed.
 * The park recovers, and the unit re-runs the parked stage, once every target has passed.
 */
export type ParkState = Readonly<{ seq: number; at: IsoTime; park: ParkRecord; passed: readonly ProbeTarget[] }>;

/**
 * A re-entered unit's lineage (M2): the unit it re-enters and the lineage's first unit. `prepared`: its
 * `prepare` stage recorded an outcome, so the edges on its predecessor now resolve to it.
 */
export type Lineage = Readonly<{ reenters: UnitId; root: UnitId; prepared: boolean }>;

/** A spec revision the log recorded for a unit: its `rev` and the sha256 of the file's bytes. */
export type SpecState = Readonly<{ rev: SpecRev; sha256: Sha256Hex }>;

/**
 * M3 (step A3): where an architect's command sends a unit next, outside the transition table, until the stage it
 * names records an outcome that is not a hold. `steer` (R11): one steer round, the build of a fresh session with
 * the brief (`steered`); `merge-in`: its lanes, after the integration tip was merged into its branch (`merged-in`).
 * `seq` is the fact's.
 */
export type EntryPoint =
  | Readonly<{ kind: 'steer'; seq: number; command: CommandId; brief: Sha256Hex; budgetMin: number; resume: boolean }>
  | Readonly<{ kind: 'merge-in'; seq: number; command: CommandId }>;

/** A unit's position and everything the transition table reads, derived from the log alone. */
export type UnitState = Readonly<{
  unit: UnitId;
  /** The stage of its latest stage-parented intent or stage-outcome fact; plan-check after a reopen. */
  stage: Stage;
  /** The riskFloor of the unit's latest dispatch fact (a plan-check raise re-pins it); null before one. */
  risk: RiskTier | null;
  status: UnitStatus;
  counters: UnitCounters;
  /** Judgment stages routed up to their role's escalation seat; they stay there for the rest of the unit. */
  routedUp: readonly JudgmentStage[];
  /** A risk trigger is pending: the next judgment dispatch sits on the escalation seat. */
  promotion: boolean;
  /**
   * The latest stage-outcome fact that decided the unit's next step: every class but `hold` (a held stage
   * re-runs what this outcome decided). The unit driver derives its next stage and that stage's inputs from
   * it; null before the first outcome and after a reopen (both start at plan-check).
   */
  decided: StageOutcomeFact | null;
  /**
   * The unit's latest `hold` fact while no later outcome has decided, else null: the interrupted attempt the
   * held stage's re-run starts from. An interrupted build is continued, not restarted (the `continue` round,
   * src/pipeline/rounds.ts); a chain of pauses keeps the latest.
   */
  interrupted: StageOutcomeFact | null;
  /** The latest gate approval: its attempt and the fingerprint it binds to; null before one. */
  approval: Readonly<{ attempt: number; fingerprint: ApprovalFingerprint }> | null;
  /**
   * The latest stage start (highest attempt) while no stage-outcome fact records it: an attempt a crash cut
   * short, whose invocations recovery has since closed (the driver consumes a completed backend call instead
   * of dispatching again, unit.ts), or a retire, which records no outcome. Null once it has its outcome.
   */
  open: Readonly<{ stage: Stage; attempt: number }> | null;
  /**
   * The unit's spec in force as the log last recorded it: its first `dispatch` fact's, a done `spec.patch`'s,
   * a `reopened` fact's or an evidence-only `plan-applied` edit's revision and hash; null before the first
   * dispatch. Stages load the spec by this hash; a revision must be at this rev + 1.
   */
  spec: SpecState | null;
  /** The latest `reopened` fact's command (null: a revision a start applied) and spec rev; null before one. */
  reopened: Readonly<{ command: CommandId | null; specRev: SpecRev }> | null;
  /**
   * A spec revision (the recorded rev + 1) a `plan-applied` fact holds for the unit until it re-opens on it:
   * at its next stage boundary that allows it while in flight, or by `resume <unit>` while parked at a
   * judgment stage. `command` is the apply that recorded it (null for a start). Null when none is pending.
   */
  pendingRevision: Readonly<{ rev: SpecRev; sha256: Sha256Hex; command: CommandId | null }> | null;
  /**
   * `counters.redirects` at the latest reopen (0 before one): the redirect bound counts only the redirects
   * since the architect's latest spec revision (`redirectsSinceEdit`).
   */
  redirectBase: number;
  /** The unit's park while `park-pending` (M2); null otherwise. */
  park: ParkState | null;
  /** The latest retryable park recovery (M2): when, and the targets that passed; null before one. */
  lastRecovery: Readonly<{ at: IsoTime; targets: readonly ProbeTarget[] }> | null;
  /**
   * The implementer's seat tier (A11): `max(risk, escalated)`, `high` once an `implementer-escalated` fact
   * moved it; null before the first dispatch. The routing-changed check compares against `build.<buildTier>`.
   */
  buildTier: RiskTier | null;
  /** Set on a unit that re-enters another (M2); null otherwise. */
  lineage: Lineage | null;
  /** The unit that re-enters this one, once it is `superseded`; null otherwise. */
  supersededBy: UnitId | null;
  /** M3 (`limits`): the bounds its latest dispatch record pins (`DEFAULT_BOUNDS` before one, or when it names none). */
  bounds: Bounds;
  /** M3: the entry a `steered` or `merged-in` fact set, until its stage records an outcome that is not a hold; else null. */
  entry: EntryPoint | null;
  /**
   * M3 (R11): the steer pass in progress, from `steered` to its exit (the transition table's steer rows): its seq and
   * whether a green exit goes on (`--resume`). Cleared by an outcome that parks, stops or retires the unit, and by a
   * gate outcome that advances it. Null otherwise.
   */
  steering: Readonly<{ seq: number; resume: boolean }> | null;
}>;

export function newUnitState(unit: UnitId, stage: Stage, risk: RiskTier | null, spec: SpecState | null = null, bounds: Bounds = DEFAULT_BOUNDS): UnitState {
  const retries = Object.fromEntries(RETRY_STAGES.map((s) => [s, 0])) as Record<RetryStage, number>;
  return {
    unit, stage, risk, status: 'active', routedUp: [], promotion: false, decided: null, interrupted: null, approval: null, open: null,
    counters: { attempts: 0, chargeableFailures: 0, redirects: 0, reviseRounds: 0, candidateReds: 0, retries },
    spec, reopened: null, pendingRevision: null, redirectBase: 0,
    park: null, lastRecovery: null, buildTier: risk, lineage: null, supersededBy: null, bounds, entry: null, steering: null,
  };
}

/** The higher of two risk tiers. */
export function maxTier(a: RiskTier, b: RiskTier | null): RiskTier {
  return b !== null && RISK_TIERS.indexOf(b) > RISK_TIERS.indexOf(a) ? b : a;
}

/** The stage an entry point runs (M3): a steer's round is a build, a merge-in re-enters at lanes. */
export const ENTRY_STAGE = { steer: 'build', 'merge-in': 'lanes' } as const satisfies Readonly<Record<EntryPoint['kind'], Stage>>;

/** Redirects applied since the architect's latest spec revision: what MAX_REDIRECTS bounds. */
export const redirectsSinceEdit = (u: UnitState): number => u.counters.redirects - u.redirectBase;

const specOf = (record: DispatchRecord): SpecState => ({ rev: record.specRev, sha256: record.specSha256 });

const STATUS_OF: Partial<Record<StageOutcomeFact['class'], UnitStatus>> = {
  hold: 'held', park: 'park-pending', stop: 'stop-pending', retire: 'retired',
};

/**
 * The effect of one stage-outcome fact on its unit: the one derivation the fold and the transition
 * function (`src/pipeline/transitions.ts`) share, so the counters a decision predicts are the counters the
 * log derives. `attempts` is left to the caller: it counts stage starts, which the fold sees.
 */
export function afterStageOutcome(u: UnitState, f: Pick<StageOutcomeFact, 'stage' | 'class' | 'chargeable'>): UnitState {
  const c = u.counters;
  const add = (cls: StageOutcomeFact['class']): number => (f.class === cls ? 1 : 0);
  const judgment = (JUDGMENT_STAGES as readonly Stage[]).includes(f.stage);
  return {
    ...u,
    stage: f.stage,
    counters: {
      ...c,
      chargeableFailures: c.chargeableFailures + (f.chargeable ? 1 : 0),
      redirects: c.redirects + add('redirect'),
      reviseRounds: c.reviseRounds + add('revise'),
      candidateReds: c.candidateReds + add('candidate-red'),
      // The fact validator admits `retry` only at a retry stage.
      retries: f.class === 'retry' ? { ...c.retries, [f.stage]: c.retries[f.stage as RetryStage] + 1 } : c.retries,
    },
    status: STATUS_OF[f.class] ?? 'active',
    // The fact validator admits `route-up` only at a judgment stage.
    routedUp: f.class === 'route-up' && !u.routedUp.includes(f.stage as JudgmentStage)
      ? [...u.routedUp, f.stage as JudgmentStage].sort()
      : u.routedUp,
    // A trigger holds until a judgment stage decides; a retry or a hold re-dispatches the same judgment, so it keeps it.
    promotion: f.class === 'trigger' ? true : judgment && f.class !== 'retry' && f.class !== 'hold' ? false : u.promotion,
  };
}

/** Whom a meter total charges: a role's unit calls, or a backend's start-up smokes. */
export type MeterCharge = Readonly<{ type: 'role'; role: Role }> | Readonly<{ type: 'smoke'; backend: Backend }>;

/** Spend per role (or smoke backend) and revision: `known` invocations with token usage, `unavailable` ones without. Never a model id. */
export type MeterTotal = Readonly<{
  charge: MeterCharge;
  routingRev: RoutingRev;
  known: number;
  unavailable: number;
  inputTokens: number;
  outputTokens: number;
  /** Sums of the reported figures; a backend that reports null for a figure contributes nothing. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  costUsd: number;
}>;

// ---------------------------------------------------------------------------------------------------
// The resource table (DESIGN §2.2 Locks): derived incrementally from `resource.transition` ops.

export type HeldState = 'reserved' | 'running' | 'cleaning';

export type ResourceStatus =
  | Readonly<{ state: 'free' }>
  | Readonly<{ state: HeldState | 'cleanup-failed'; holder: Holder }>;

/** A resource unit's state after its last done transition, and the transition still open on it, if any. */
export type ResourceEntry = Readonly<{ status: ResourceStatus; pending: IntentOf<'resource.transition'> | null }>;

export const FREE_RESOURCE: ResourceEntry = { status: { state: 'free' }, pending: null };

export const sameHolder = (a: Holder, b: Holder): boolean => canonicalJson(a) === canonicalJson(b);

/** The state `edge` moves a resource in `status` to under `holder`, or why it may not. */
export function afterEdge(status: ResourceStatus, holder: Holder, edge: ResourceEdge): ResourceStatus | string {
  if (edge.type === 'reserve') return status.state === 'free' ? { state: 'reserved', holder } : `reserve of a ${status.state} resource`;
  if (edge.type === 'reclaim') {
    if (!(RECLAIM_HOLDERS as readonly string[]).includes(holder.type)) return `reclaim by a ${holder.type} holder`;
    return status.state === 'cleanup-failed' ? { state: 'cleaning', holder } : `reclaim of a ${status.state} resource`;
  }
  if (status.state === 'free') return `${edge.type} of a free resource`;
  if (!sameHolder(status.holder, holder)) return `${edge.type} by ${canonicalJson(holder)} of a resource held by ${canonicalJson(status.holder)}`;
  const from = edge.type === 'run' ? 'reserved' : edge.type === 'clean' ? edge.from : 'cleaning';
  if (status.state !== from) return `${edge.type} of a ${status.state} resource`;
  switch (edge.type) {
    case 'run':
      return { state: 'running', holder };
    case 'clean':
      return { state: 'cleaning', holder };
    case 'release':
      return { state: 'free' };
    case 'fail':
      return { state: 'cleanup-failed', holder };
  }
}

/**
 * A backend's current park (F12): the latest `backend-park` fact's seq (its epoch) and class. A usage-limit
 * park dominates: a later retryable park keeps the class `usage-limit` (with the later seq), and only
 * `resume --backend` clears it. A retryable park clears on a passing probe covering exactly `seq`.
 */
export type BackendParkState = Readonly<{ backend: Backend; seq: number; class: BackendParkClass }>;

/**
 * An own-arc residue as the log proves it (A9; SCHEMAS.md "M2: parks", residue probing): the residue a done
 * `resource.transition{fail}` recorded on an instance that no `release` has followed since. `key` is its host
 * index key, `holder` the stage attempt whose cleanup failed, `fail` that transition's op and `failSeq` its seq
 * (what a probe of the instance covers for it), and `at` the time of its done. A residue disposed of but not yet released (a
 * crash in the reclaim order) is still here: the reclaim order ends with the release.
 */
export type ResidueState = Readonly<{ key: ResidueKey; holder: ResidueHolder; fail: OpId; failSeq: number; at: IsoTime }>;
/** A residue's holder: the stage attempt, or (M3, G4) the job, whose cleanup failed. */
export type ResidueHolder = Extract<Holder, { type: (typeof RESIDUE_HOLDERS)[number] }>;
/** The latest probe of one target, with the time its fact was written. */
export type ProbeState = Extract<Fact, { kind: 'probe' }> & Readonly<{ seq: number; at: IsoTime }>;

export type EdgeResolvedState = Readonly<{ command: CommandId; evidence: string; seq: number }>;

/** The outcomes whose park needs a spec revision or a re-entry (A7's operator-design rows). */
const DESIGN_PARK_OUTCOMES: ReadonlySet<string> = new Set([
  'refusal', 'escalate', 'infeasible', 'risk-lowered', 'scope-widened', 'redirect', 'revise', 'malformed', 'empty-diff', 'red',
]);

/**
 * The park of a parking `stage-outcome` fact without `park`, which only the interim M2 shim writes (a retryable row whose
 * stage names no targets, src/pipeline/transitions.ts `outcomeFact`; BACKLOG "Scaffolding to delete"): an operator
 * park, `design` for the chargeable bound and the design rows, `env` for every other.
 */
function unclassedParkRecord(f: StageOutcomeFact): ParkRecord {
  return { class: 'operator', kind: f.chargeable || DESIGN_PARK_OUTCOMES.has(f.outcome) ? 'design' : 'env' };
}

// ---------------------------------------------------------------------------------------------------
// M3: the holistic layer's fold (SCHEMAS.md "M3: the holistic layer"). Raw facts, indexed and checked; the
// derivations over them (observations, coverage watermarks, generations, convergence, digests to raise) are the
// later steps' pure functions over this view.

type Seq = Readonly<{ seq: number }>;
type FactOf<K extends HolisticFact['kind']> = Extract<HolisticFact, { kind: K }>;
/** M4a: a banked debt item as the fold keeps it: its fact (what `mintDebt` and `ledgerAfterArc` read) and seq. */
export type BankedDebt = Extract<Fact, { kind: 'debt-banked' }> & Seq;
type M4aFactOf<K extends Fact['kind']> = Omit<Extract<Fact, { kind: K }>, 'kind'> & Seq;
/** M4a: a corpus amendment (`M-n`, in id order), its source unique. */
export type AmendmentState = M4aFactOf<'corpus-amendment'>;
/** M4a: a checkpoint's outcome for one captured issue, one per `(job, issue)`. */
export type IntakeState = M4aFactOf<'issue-intake'>;
/** M4a: a pack review job: its kept inputs' fact, and its end (null while running). */
export type PackReviewState = Readonly<{ started: M4aFactOf<'pack-review-started'>; ended: M4aFactOf<'pack-review-ended'> | null }>;
/** M4a: a checkpoint's issue capture, written for the next checkpoint job before its `checkpoint-inputs`. */
export type IssueCaptureState = M4aFactOf<'issues-captured'>;

/** A finding as the log last moved it. `owner`: the unit of its latest `owned` or `fixed-on-branch` move. */
export type FindingState = Omit<FactOf<'finding-opened'>, 'kind'> & Readonly<{
  state: FindingStateName;
  owner: UnitId | null;
  openedSeq: number;
  /** The latest move's target (null while never moved). */
  last: FindingTo | null;
}>;

export type AuditState = Readonly<{ started: AuditInputs & Seq; ended: (Omit<FactOf<'audit-ended'>, 'kind' | 'job'> & Seq) | null }>;
/** A checkpoint job: its captured inputs, and its decision: a bundle outcome, or the plan revision its bundle applied. */
export type CheckpointState = Readonly<{
  inputs: Omit<FactOf<'checkpoint-inputs'>, 'kind'> & Seq;
  decided: (Readonly<{ kind: 'applied'; planRev: PlanRev }> | BundleOutcome) | null;
}>;
/** A20: the latest `arc-completed`; `active` while the plan rev and the integration head are those it recorded and no reopen followed. */
export type CompletionState = Omit<FactOf<'arc-completed'>, 'kind'> & Seq & Readonly<{ active: boolean }>;

export type HolisticFold = Readonly<{
  /** A5: the plan in force names a vision (its `plan-applied` records `visionSha256`). */
  on: boolean;
  witnessed: readonly (Omit<FactOf<'witnessed'>, 'kind'> & Seq)[];
  latched: readonly (Omit<FactOf<'obligation-latched'>, 'kind'> & Seq)[];
  findings: readonly FindingState[];
  audits: readonly AuditState[];
  auditRequests: readonly (Omit<FactOf<'audit-requested'>, 'kind'> & Seq)[];
  docsCovered: readonly (Omit<FactOf<'docs-covered'>, 'kind'> & Seq)[];
  docsPublished: readonly (Omit<FactOf<'docs-published'>, 'kind'> & Seq)[];
  checkpoints: readonly CheckpointState[];
  divergences: readonly (Omit<FactOf<'divergence'>, 'kind'> & Seq)[];
  digests: readonly (Omit<FactOf<'divergence-digest'>, 'kind'> & Seq)[];
  steered: readonly (Omit<FactOf<'steered'>, 'kind'> & Seq)[];
  mergedIn: readonly (Omit<FactOf<'merged-in'>, 'kind'> & Seq)[];
  /** M4a (R7): the debt this arc banked, in log order; one per source, id and key (src/debt/mint.ts `mintDebt`). */
  debt: readonly BankedDebt[];
  /** M4a: the corpus amendments, in id order (src/holistic/amendments.ts). */
  amendments: readonly AmendmentState[];
  /** M4a: the checkpoints' issue outcomes, in log order (src/holistic/intake.ts). */
  intake: readonly IntakeState[];
  /** M4a: the pack reviews, in job order; at most one running (src/holistic/packreview.ts). */
  packReviews: readonly PackReviewState[];
  /** M4a: the checkpoints' issue captures, in log order. */
  captures: readonly IssueCaptureState[];
  /** `close-admissions` latched and no architect admit since (§2.10). */
  draining: Readonly<{ command: CommandId; seq: number }> | null;
  completion: CompletionState | null;
}>;

/** Records after which the arc is not sealed (A20, H5): every record but these quiet ones is work. */
function isWork(record: Event): boolean {
  if (record.type === 'fact') {
    const k = record.fact.kind;
    return !['executor-started', 'containment-mode', 'tail-discarded', 'arc-completed', 'docs-published', 'probe', 'backend-park', 'meter', 'usage-unavailable'].includes(k);
  }
  if (record.type === 'intent') return record.parent.type === 'stage' || record.parent.type === 'job' || record.parent.type === 'command' || record.kind === 'revision.commit';
  return false;
}

/** The fold's result, and the content of the `state.json` cache. Sets are sorted arrays. */
export type DerivedState = Readonly<{
  v: SchemaVersion;
  arc: ArcId;
  /** The latest `plan-applied` fact's revision and plan hash (the plan in force); null before one. */
  plan: Readonly<{ rev: PlanRev; planSha256: Sha256Hex }> | null;
  /** Seq of the last event folded; 0 for an empty log. */
  lastSeq: number;
  /** The highest event seq a published `snapshot.publish` carried to `refs/roadmap/<arc>`; 0 before the first. */
  snapshotHighWater: number;
  /** Open intents in log order, at most one per key. */
  openIntents: readonly IntentRecord[];
  units: readonly UnitState[];
  meter: readonly MeterTotal[];
  /** Ids raised by a done `needsuser.raise`. */
  needsUser: readonly NeedsUserId[];
  /** Raised ids whose raise was blocking. */
  needsUserBlocking: readonly NeedsUserId[];
  /** Ids acknowledged by a `needs-user-acked` fact (any id form: supervisor and host items too). */
  needsUserAcked: readonly NeedsUserId[];
  /** The durable pause and stop markers (commands, step 13). */
  control: ControlState;
  /** The latest recorded `containment-mode` fact, or null before one. */
  containmentMode: ContainmentMode | null;
  /** Every `tail-discarded` fact, in log order. */
  tailDiscarded: readonly TailDiscarded[];
  /** Backends parked arc-wide by a `backend-park` fact (usage limit, capacity or outage), ascending. */
  parkedBackends: readonly Backend[];
  /** M2: each parked backend's current park epoch and class, ascending by backend. */
  backendParks: readonly BackendParkState[];
  /** M2: every resource unit a transition named, ascending in lock order, with its state and open transition. */
  resources: readonly Readonly<{ unit: ResourceUnit; status: ResourceStatus; pending: OpId | null }>[];
  /** M2: the `run-only` allowlist in force, or null. */
  runOnly: readonly UnitId[] | null;
  /** M2: contingent edges resolved, ascending. */
  resolvedEdges: readonly EdgeId[];
  /** M3: the holistic layer's fold. */
  holistic: HolisticFold;
}>;

type Closure = Readonly<{ type: 'done'; record: DoneRecord }> | Readonly<{ type: 'abort'; record: AbortRecord }>;
type OpEntry = { latest: IntentRecord; closure: Closure | null };
/** `starts` and `outcomes` hold `<stage>#<attempt>`; `state.counters.attempts` is `starts.size`. */
/** `beforeDecided`: the unit's decision and interruption before its latest decided outcome (a reroute restores them). */
/** `attemptBase`: the attempts a re-entered unit inherits from its lineage (0 otherwise). */
type UnitEntry = {
  starts: Set<string>; outcomes: Set<string>; state: UnitState; attemptBase: number;
  beforeDecided: Readonly<{ decided: StageOutcomeFact | null; interrupted: StageOutcomeFact | null }>;
};
type MeterEntry = { -readonly [F in keyof MeterTotal]: MeterTotal[F] };

/**
 * The incremental fold. `apply` checks every invariant before it changes anything, so a rejected event
 * leaves the fold as it was. It is also the journal's live `JournalView`.
 */
export class Fold implements JournalView {
  readonly arc: ArcId;
  #lastSeq = 0;
  #lastHash: Sha256Hex | null = null;
  #snapshotHighWater = 0;
  readonly #ops = new Map<OpId, OpEntry>();
  /** Insertion order is log order: an op is deleted when closed and re-inserted by its retry. */
  readonly #open = new Map<OpId, IntentRecord>();
  readonly #openByKey = new Map<OpKey, OpId>();
  readonly #units = new Map<UnitId, UnitEntry>();
  /** Every `dispatch` fact per unit, in log order: the latest is the record in force. */
  readonly #dispatches = new Map<UnitId, DispatchRecord[]>();
  /** M3: the seq of each unit's latest dispatch fact, and of the latest `plan-applied` recording it `unit-changed`. */
  readonly #pinSeq = new Map<UnitId, number>();
  readonly #unitChangedSeq = new Map<UnitId, number>();
  /** The spec the unit's dispatch facts name: its first pin's (a re-pin keeps it; see the `dispatch` case). */
  readonly #pinnedSpec = new Map<UnitId, SpecState>();
  readonly #meter = new Map<string, MeterEntry>();
  readonly #metered = new Set<InvocationId>();
  readonly #needsUser = new Map<NeedsUserId, { blocking: boolean }>();
  readonly #acks = new Map<NeedsUserId, NeedsUserAckState>();
  #stop: CommandId | null = null;
  #pausedAll = false;
  readonly #pausedUnits = new Set<UnitId>();
  #containmentMode: ContainmentMode | null = null;
  #planApplied: PlanAppliedFact | null = null;
  readonly #plannedUnits = new Set<UnitId>();
  readonly #appliedBy = new Map<CommandId, PlanAppliedFact>();
  readonly #tail: TailDiscarded[] = [];
  readonly #backendParks = new Map<Backend, BackendParkState>();
  /** Every park seq the log holds: a unit park's stage-outcome seq → its unit, a backend park's seq → its backend. */
  readonly #unitParkSeqs = new Map<number, UnitId>();
  readonly #backendParkSeqs = new Map<number, Backend>();
  readonly #resources = new Map<ResourceUnit, ResourceEntry>();
  /** Own-arc residues by instance (`ResidueState`), and every fail transition's seq → the instances it failed. */
  readonly #residues = new Map<ResourceInstance, ResidueState>();
  readonly #failSeqs = new Map<number, readonly ResourceInstance[]>();
  readonly #probes = new Map<string, ProbeState>();
  readonly #judgmentInputs = new Map<string, JudgmentInputs>();
  readonly #resolvedEdges = new Map<EdgeId, EdgeResolvedState>();
  #runOnly: readonly UnitId[] | null = null;
  /** Rank's seqs (F17): each stage-outcome fact's by `<unit>/<stage>#<attempt>`, each published ff's done, each unit's first naming. */
  readonly #outcomeSeqs = new Map<string, number>();
  readonly #publications: Readonly<{ unit: UnitId; seq: number }>[] = [];
  readonly #addedSeqs = new Map<UnitId, number>();
  // M3
  #holisticOn = false;
  /** The integration head as the log knows it: the latest published `integration.ff`'s `new`. */
  #head: Sha | null = null;
  #lastWorkSeq = 0;
  #lastReopenSeq = 0;
  readonly #jobs = new Map<JobKind, number>();
  readonly #batchMembers = new Map<JobId, readonly UnitId[]>();
  readonly #witnessed: (Omit<FactOf<'witnessed'>, 'kind'> & Seq)[] = [];
  readonly #latched = new Map<ObligationId, Omit<FactOf<'obligation-latched'>, 'kind'> & Seq>();
  readonly #findings = new Map<FindingId, FindingState>();
  readonly #audits: { started: AuditInputs & Seq; ended: AuditState['ended'] }[] = [];
  readonly #auditRequests: (Omit<FactOf<'audit-requested'>, 'kind'> & Seq)[] = [];
  readonly #docsCovered: (Omit<FactOf<'docs-covered'>, 'kind'> & Seq)[] = [];
  readonly #docsPublished: (Omit<FactOf<'docs-published'>, 'kind'> & Seq)[] = [];
  readonly #checkpoints = new Map<JobId, { inputs: CheckpointState['inputs']; decided: CheckpointState['decided'] }>();
  readonly #divergences: (Omit<FactOf<'divergence'>, 'kind'> & Seq)[] = [];
  readonly #digests: (Omit<FactOf<'divergence-digest'>, 'kind'> & Seq)[] = [];
  readonly #steered: (Omit<FactOf<'steered'>, 'kind'> & Seq)[] = [];
  readonly #mergedIn: (Omit<FactOf<'merged-in'>, 'kind'> & Seq)[] = [];
  readonly #debt: BankedDebt[] = [];
  readonly #amendments: AmendmentState[] = [];
  readonly #intake: IntakeState[] = [];
  readonly #packReviews: { started: PackReviewState['started']; ended: PackReviewState['ended'] }[] = [];
  readonly #captures: IssueCaptureState[] = [];
  #draining: Readonly<{ command: CommandId; seq: number }> | null = null;
  #completion: (Omit<FactOf<'arc-completed'>, 'kind'> & Seq) | null = null;

  constructor(arc: ArcId) {
    this.arc = arc;
  }

  /** The chain hash of the last line folded (the next line's `prev`); null for an empty log. */
  lastHash(): Sha256Hex | null {
    return this.#lastHash;
  }

  /** Folds one event whose line bytes hash to `lineHash` (`prevHash(line)`). Throws FoldInvariantError. */
  apply(event: Event, lineHash: Sha256Hex): void {
    const fail = (detail: string): never => {
      throw new FoldInvariantError(event.seq, detail);
    };
    if (event.arc !== this.arc) fail(`arc ${event.arc} in the log of arc ${this.arc}`);
    if (event.seq !== this.#lastSeq + 1) fail(`seq not contiguous: expected ${this.#lastSeq + 1}`);
    if (event.prev !== this.#lastHash) fail(`chain broken: prev ${event.prev}, previous line hashes to ${this.#lastHash}`);
    const before = this.#counters();
    switch (event.type) {
      case 'intent':
        this.#intent(event, fail);
        break;
      case 'done':
        this.#done(event, { seq: event.seq, at: event.at }, fail);
        break;
      case 'abort':
        this.#abort(event, fail);
        break;
      case 'fact':
        this.#fact(event.fact, fail, { seq: event.seq, at: event.at });
        break;
    }
    if (isWork(event)) this.#lastWorkSeq = event.seq;
    this.#lastSeq = event.seq;
    this.#lastHash = lineHash;
    monotonic(before, this.#counters());
  }

  #intent(r: IntentRecord, fail: (detail: string) => never): void {
    const entry = this.#ops.get(r.op);
    if (r.ordinal === 1) {
      if (entry !== undefined) fail(`op ${r.op} already has an intent; a retry takes the next ordinal`);
      const seq = parseOpId(r.op).seq;
      if (seq !== this.#lastSeq + 1) fail(`op ${r.op} must be named after its first intent's seq ${this.#lastSeq + 1}`);
    } else {
      if (entry === undefined) return fail(`retry ordinal ${r.ordinal} of unknown op ${r.op}`);
      const prev = entry.latest;
      if (r.ordinal !== prev.ordinal + 1) fail(`ordinal ${r.ordinal} of ${r.op} does not follow ${prev.ordinal}`);
      if (entry.closure === null) fail(`retry of ${r.op} while ordinal ${prev.ordinal} is open`);
      if (!retryable(entry.closure)) fail(`retry of ${r.op} after ${closureName(entry.closure)}; only a lost or aborted ordinal is retried`);
      if (r.kind !== prev.kind) fail(`retry of ${r.op} changes kind ${prev.kind} to ${r.kind}`);
      if (r.key !== prev.key) fail(`retry of ${r.op} changes key ${prev.key} to ${r.key}`);
      if (canonicalJson(r.parent) !== canonicalJson(prev.parent)) fail(`retry of ${r.op} changes its parent`);
      if (r.deadlineAt !== prev.deadlineAt) fail(`retry of ${r.op} changes deadlineAt ${prev.deadlineAt} to ${r.deadlineAt}`);
    }
    const holder = this.#openByKey.get(r.key);
    if (holder !== undefined) fail(`key ${r.key} already has open intent ${holder}`);
    if (r.kind === 'resource.transition') {
      for (const res of r.expect.resources) {
        const pending = this.#resources.get(res)?.pending ?? null;
        if (pending !== null) fail(`${r.op} moves ${res} while ${pending.op} is open on it`);
      }
    }

    this.#ops.set(r.op, { latest: r, closure: null });
    if (r.parent.type === 'job') this.#seeJob(r.parent.job);
    if (r.kind === 'resource.transition') {
      const h = r.expect.holder;
      if (h.type === 'job') this.#seeJob(h.job);
      if (h.type === 'docs') this.#seeJob(h.pub);
    }
    if (r.kind === 'candidate.merge' && r.expect.batch !== undefined) {
      this.#seeJob(r.expect.batch.job);
      this.#batchMembers.set(r.expect.batch.job, r.expect.batch.members.map((m) => m.unit));
    }
    if (r.kind === 'docs.commit') this.#seeJob(r.expect.pub);
    if (r.kind === 'resource.transition') {
      for (const res of r.expect.resources) this.#resources.set(res, { status: (this.#resources.get(res) ?? FREE_RESOURCE).status, pending: r });
    }
    this.#open.set(r.op, r);
    this.#openByKey.set(r.key, r.op);
    if (r.parent.type === 'stage') {
      const { unit, stage, attempt } = r.parent;
      const u = this.#unit(unit, stage);
      u.state = { ...u.state, stage };
      this.#start(u, `${stage}#${attempt}`);
    }
  }

  #unit(unit: UnitId, stage: Stage): UnitEntry {
    const existing = this.#units.get(unit);
    if (existing !== undefined) return existing;
    const u: UnitEntry = {
      starts: new Set<string>(), outcomes: new Set<string>(), state: this.#fresh(unit, stage), attemptBase: 0,
      beforeDecided: { decided: null, interrupted: null },
    };
    this.#units.set(unit, u);
    return u;
  }

  /** A unit with no stage state yet: at `stage`, with its latest pin's risk floor and bounds and its pinned spec. */
  #fresh(unit: UnitId, stage: Stage): UnitState {
    const pin = this.#dispatches.get(unit)?.at(-1) ?? null;
    return newUnitState(unit, stage, pin?.riskFloor ?? null, this.#pinnedSpec.get(unit) ?? null, boundsOfRecord(pin));
  }

  #start(u: UnitEntry, start: string): void {
    u.starts.add(start);
    u.state = { ...u.state, counters: { ...u.state.counters, attempts: u.attemptBase + u.starts.size }, open: openStart(u) };
  }

  #openEntry(op: OpId, what: string, fail: (detail: string) => never): OpEntry {
    const entry = this.#ops.get(op);
    if (entry === undefined) return fail(`${what} of unknown op ${op}`);
    if (entry.closure !== null) fail(`${what} of ${op}, whose ordinal ${entry.latest.ordinal} is already closed by ${closureName(entry.closure)}`);
    return entry;
  }

  #close(entry: OpEntry, closure: Closure): void {
    entry.closure = closure;
    this.#open.delete(entry.latest.op);
    this.#openByKey.delete(entry.latest.key);
  }

  #done(r: DoneRecord, { seq, at }: Readonly<{ seq: number; at: IsoTime }>, fail: (detail: string) => never): void {
    const entry = this.#openEntry(r.op, 'done', fail);
    const intent = entry.latest;
    if (r.kind !== intent.kind) fail(`done of kind ${r.kind} for ${r.op}, an intent of kind ${intent.kind}`);
    const moved: [ResourceUnit, ResourceStatus][] = [];
    if (intent.kind === 'resource.transition') {
      const { holder, resources, edge } = intent.expect;
      for (const res of resources) {
        const next = afterEdge((this.#resources.get(res) ?? FREE_RESOURCE).status, holder, edge);
        if (typeof next === 'string') return fail(`${r.op} is illegal for ${res}: ${next}`);
        moved.push([res, next]);
      }
    }
    this.#close(entry, { type: 'done', record: r });
    for (const [res, status] of moved) this.#resources.set(res, { status, pending: null });
    if (intent.kind === 'resource.transition') this.#residuesAfter(intent, at, fail);
    if (intent.kind === 'needsuser.raise') this.#needsUser.set(intent.expect.id, { blocking: intent.expect.blocking });
    // A unit's publication is its ff stage's; an ff under another parent (the git primitives' own tests) publishes no unit.
    // M3: a batch's `ff` publishes and retires every member at once (R7, H4); a docs `ff` publishes no unit.
    if (intent.kind === 'integration.ff' && r.kind === 'integration.ff' && r.outcome.kind === 'published') {
      this.#head = intent.expect.new;
      const subject = intent.expect.subject;
      if (subject === undefined && intent.parent.type === 'stage') this.#publications.push({ unit: intent.parent.unit, seq });
      if (subject?.type === 'batch') {
        const members = this.#batchMembers.get(subject.job);
        if (members === undefined) return fail(`${r.op} publishes batch ${subject.job}, which no candidate.merge named`);
        for (const unit of members) {
          this.#publications.push({ unit, seq });
          const u = this.#unit(unit, 'ff');
          u.state = { ...u.state, status: 'retired' };
        }
      }
    }
    if (intent.kind === 'snapshot.publish') this.#snapshotHighWater = Math.max(this.#snapshotHighWater, intent.expect.highWater);
    if (intent.kind === 'spec.patch' && intent.parent.type === 'stage') {
      const u = this.#unit(intent.parent.unit, intent.parent.stage);
      u.state = { ...u.state, spec: { rev: intent.post.newRev, sha256: intent.post.newSha256 } };
    }
  }

  /** A done `fail` records its residues; a `release` ends the residue of each instance it frees. */
  #residuesAfter(intent: IntentOf<'resource.transition'>, at: IsoTime, fail: (detail: string) => never): void {
    const { holder, resources, edge } = intent.expect;
    if (edge.type === 'release') for (const res of resources) this.#residues.delete(res as ResourceInstance);
    if (edge.type !== 'fail') return;
    if (holder.type !== 'stage' && holder.type !== 'job') return fail(`${intent.op}: a fail transition held by ${canonicalJson(holder)}; only a stage or job holder records residues`);
    const failSeq = parseOpId(intent.op).seq;
    this.#failSeqs.set(failSeq, edge.residues.map((r) => r.resource));
    for (const r of edge.residues) {
      const base = { arc: this.arc, inv: r.teardown, resource: r.resource };
      const key: ResidueKey = holder.type === 'stage' ? { ...base, unit: holder.unit } : { ...base, job: holder.job };
      this.#residues.set(r.resource, { key, holder, fail: intent.op, failSeq, at });
    }
  }

  #abort(r: AbortRecord, fail: (detail: string) => never): void {
    const entry = this.#openEntry(r.op, 'abort', fail);
    this.#close(entry, { type: 'abort', record: r });
    // An aborted transition never happened.
    const intent = entry.latest;
    if (intent.kind === 'resource.transition') {
      for (const res of intent.expect.resources) this.#resources.set(res, { status: (this.#resources.get(res) ?? FREE_RESOURCE).status, pending: null });
    }
  }

  #fact(f: Fact, fail: (detail: string) => never, at: Readonly<{ seq: number; at: IsoTime }>): void {
    switch (f.kind) {
      case 'tail-discarded':
        this.#tail.push(f);
        return;
      case 'meter':
      case 'usage-unavailable': {
        const { op, ordinal } = parseInvocationId(f.inv);
        const entry = this.#ops.get(op);
        if (entry === undefined || ordinal > entry.latest.ordinal) fail(`${f.kind} for ${f.inv}, which no intent opened`);
        // One usage fact per invocation, so a replayed or duplicated report can never count twice.
        if (this.#metered.has(f.inv)) fail(`second usage fact for ${f.inv}`);
        this.#metered.add(f.inv);
        const charge: MeterCharge = f.subject.type === 'smoke' ? { type: 'smoke', backend: f.subject.backend } : { type: 'role', role: f.subject.role };
        const key = `${charge.type === 'role' ? charge.role : `smoke:${charge.backend}`} ${f.routingRev}`;
        const m = this.#meter.get(key) ?? {
          charge, routingRev: f.routingRev, known: 0, unavailable: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, costUsd: 0,
        };
        if (f.kind === 'meter') {
          m.known += 1;
          m.inputTokens += f.usage.inputTokens;
          m.outputTokens += f.usage.outputTokens;
          m.cacheReadTokens += f.usage.cacheReadTokens ?? 0;
          m.cacheWriteTokens += f.usage.cacheWriteTokens ?? 0;
          m.turns += f.usage.turns ?? 0;
          m.costUsd += f.usage.costUsd ?? 0;
        } else {
          m.unavailable += 1;
        }
        this.#meter.set(key, m);
        return;
      }
      case 'dispatch': {
        const { unit, scope, riskFloor } = f.record;
        const prev = this.#dispatches.get(unit)?.at(-1);
        // A re-pin (a plan-check raise) keeps the scope envelope and never lowers the risk floor (R2). M3: the scope
        // grows only by a ruled scope-growth apply, a `unit-changed` revision of the unit since its previous pin.
        if (prev !== undefined && canonicalJson(prev.scope) !== canonicalJson(scope)) {
          const grown = prev.scope.every((p) => scope.includes(p));
          if (!grown || (this.#unitChangedSeq.get(unit) ?? -1) < (this.#pinSeq.get(unit) ?? -1)) fail(`dispatch of ${unit} changes its pinned scope`);
        }
        this.#pinSeq.set(unit, at.seq);
        if (prev !== undefined && RISK_TIERS.indexOf(riskFloor) < RISK_TIERS.indexOf(prev.riskFloor)) {
          fail(`dispatch of ${unit} lowers riskFloor ${prev.riskFloor} to ${riskFloor}`);
        }
        const u = this.#units.get(unit);
        // A re-entered unit's first pin inherits its lineage's floor (the fold set `risk` from the predecessor).
        const lineageFloor = prev === undefined && u?.state.lineage !== null ? u?.state.risk ?? null : null;
        if (lineageFloor !== null && RISK_TIERS.indexOf(riskFloor) < RISK_TIERS.indexOf(lineageFloor)) {
          fail(`dispatch of ${unit} lowers its lineage's riskFloor ${lineageFloor} to ${riskFloor}`);
        }
        if (u !== undefined && (u.state.status === 'cut' || u.state.status === 'superseded')) fail(`dispatch of ${unit}, which is ${u.state.status}`);
        const all = this.#dispatches.get(unit) ?? [];
        all.push(f.record);
        this.#dispatches.set(unit, all);
        // Only the first pin names the spec in force: a re-pin carries the spec its record was first made at.
        const spec = prev === undefined ? specOf(f.record) : null;
        if (spec !== null) this.#pinnedSpec.set(unit, spec);
        if (u !== undefined) u.state = { ...u.state, risk: riskFloor, buildTier: maxTier(riskFloor, u.state.buildTier), spec: spec ?? u.state.spec, bounds: boundsOfRecord(f.record) };
        return;
      }
      case 'stage-outcome': {
        const key = `${f.stage}#${f.attempt}`;
        const existing = this.#units.get(f.unit);
        if (existing?.outcomes.has(key) === true) fail(`second stage-outcome for ${f.unit} ${key}`);
        const failures = existing?.state.counters.chargeableFailures ?? 0;
        const bound = existing?.state.bounds.chargeable ?? boundsOfRecord(this.dispatchOf(f.unit)).chargeable;
        if (f.chargeable && failures + 1 >= bound && f.class !== 'park') {
          fail(`stage-outcome for ${f.unit} ${key} is chargeable failure ${failures + 1}, which parks the unit, but its class is ${f.class} (the unit's bound is ${bound})`);
        }
        const status = existing?.state.status;
        if (status === 'cut' || status === 'superseded') fail(`stage-outcome for ${f.unit} ${key}, which is ${status}`);
        if (f.stage === 'prepare' && (existing?.state.lineage ?? null) === null) fail(`prepare outcome for ${f.unit}, which re-enters no unit`);
        if (f.cause !== undefined && this.#backendParkSeqs.get(f.cause.parkSeq) !== f.cause.backend) {
          fail(`hold of ${f.unit} ${key} caused by backend ${f.cause.backend}'s park at seq ${f.cause.parkSeq}, which is no park of that backend`);
        }
        const u = this.#unit(f.unit, f.stage);
        u.outcomes.add(key);
        this.#outcomeSeqs.set(`${f.unit}/${key}`, at.seq);
        // M3: an entry's stage records its outcome (a hold keeps the entry, whose stage then runs again); a steer pass
        // ends where it parks, stops or retires the unit, or where its gate advances it.
        const entry = u.state.entry;
        if (entry !== null && f.class !== 'hold' && f.stage !== ENTRY_STAGE[entry.kind]) fail(`stage-outcome for ${f.unit} ${key} while its ${entry.kind} entry is at ${ENTRY_STAGE[entry.kind]}`);
        if (f.class !== 'hold') {
          const ends = f.class === 'park' || f.class === 'stop' || f.class === 'retire' || (f.stage === 'gate' && f.class === 'advance');
          u.state = { ...u.state, entry: null, steering: ends ? null : u.state.steering };
        }
        u.state = afterStageOutcome(u.state, f);
        if (f.class === 'hold') u.state = { ...u.state, interrupted: f };
        else {
          u.beforeDecided = { decided: u.state.decided, interrupted: u.state.interrupted };
          u.state = { ...u.state, decided: f, interrupted: null };
        }
        if (f.class === 'park') {
          u.state = { ...u.state, park: { seq: at.seq, at: at.at, park: f.park ?? unclassedParkRecord(f), passed: [] } };
          this.#unitParkSeqs.set(at.seq, f.unit);
        }
        const lineage = u.state.lineage;
        if (f.stage === 'prepare' && f.class !== 'park' && lineage !== null) u.state = { ...u.state, lineage: { ...lineage, prepared: true } };
        this.#start(u, key);
        return;
      }
      case 'probe':
        this.#probe(f, fail, at);
        return;
      case 'unparked':
        this.#unpark(f.unit, fail);
        return;
      case 'judgment-inputs': {
        const key = `${f.unit} ${f.stage}#${f.attempt}`;
        // M3 (Checkpoint A): a judgment captures its inputs before its `@cpu` wait, so a wait its signal cancelled leaves
        // them for an attempt that never started; the next attempt takes that number and its capture replaces them.
        const started = this.#units.get(f.unit)?.starts.has(`${f.stage}#${f.attempt}`) ?? false;
        if (this.#judgmentInputs.has(key) && started) fail(`second judgment-inputs for ${key}`);
        const { kind: _kind, ...inputs } = f;
        this.#judgmentInputs.set(key, inputs);
        return;
      }
      case 'edge-resolved':
        if (this.#resolvedEdges.has(f.edge)) fail(`edge ${f.edge} is already resolved`);
        this.#resolvedEdges.set(f.edge, { command: f.command, evidence: f.evidence, seq: at.seq });
        return;
      case 'run-only':
        this.#runOnly = f.units;
        return;
      case 'implementer-escalated': {
        const state = this.unit(f.unit);
        if (state.buildTier === null) return fail(`implementer-escalated for ${f.unit}, which was never dispatched`);
        if (state.buildTier !== f.from) fail(`implementer-escalated for ${f.unit} from ${f.from}; its build tier is ${state.buildTier}`);
        // G1: only while a charged round is left in the budget.
        if (state.counters.chargeableFailures >= state.bounds.chargeable) fail(`implementer-escalated for ${f.unit} at the chargeable bound`);
        const u = this.#unit(f.unit, 'build');
        u.state = { ...u.state, buildTier: f.to };
        return;
      }
      case 'approval': {
        const u = this.#unit(f.unit, 'gate');
        u.state = { ...u.state, approval: { attempt: f.attempt, fingerprint: f.fingerprint } };
        return;
      }
      case 'backend-park': {
        const cur = this.#backendParks.get(f.backend);
        const cls = cur?.class === 'usage-limit' ? 'usage-limit' : f.class;
        this.#backendParks.set(f.backend, { backend: f.backend, seq: at.seq, class: cls });
        this.#backendParkSeqs.set(at.seq, f.backend);
        return;
      }
      case 'containment-mode':
        this.#containmentMode = f.mode;
        return;
      case 'needs-user-acked':
        if (this.#acks.has(f.id)) fail(`second acknowledgement of needs-user ${f.id}`);
        this.#acks.set(f.id, { command: f.command, choice: f.choice });
        return;
      case 'paused':
        if (f.target.type === 'all') this.#pausedAll = true;
        else this.#pausedUnits.add(f.target.unit);
        return;
      case 'stop-requested':
        this.#stop = f.command;
        return;
      case 'executor-started':
        // A stop ends the run it was given to; the next start begins without it. Pauses and holds persist.
        this.#stop = null;
        return;
      case 'resumed':
        this.#resumed(f.target, fail);
        return;
      case 'reopened':
        this.#reopened(f, fail);
        this.#lastReopenSeq = at.seq;
        return;
      case 'plan-applied':
        this.#planAppliedFact(f, at.seq, fail);
        for (const c of f.changes) if (c.type === 'unit-changed') this.#unitChangedSeq.set(c.unit, at.seq);
        return;
      // M4a: debt (C2); amendments, intake, pack reviews and checkpoint captures (C3).
      case 'debt-banked': {
        const same = this.#debt.find((d) => d.id === f.id || d.key === f.key || canonicalJson(d.source) === canonicalJson(f.source));
        if (same !== undefined) fail(`debt ${f.id} banked again: ${same.id} (seq ${same.seq}) has its id, key or source (banking is idempotent per source)`);
        this.#debt.push({ ...f, seq: at.seq });
        return;
      }
      case 'corpus-amendment': {
        const next = this.nextAmendmentId();
        if (f.id !== next) fail(`corpus amendment ${f.id}; the next amendment is ${next}`);
        const same = this.#amendments.find((x) => canonicalJson(x.source) === canonicalJson(f.source));
        if (same !== undefined) fail(`corpus amendment ${f.id} has the source of ${same.id} (one amendment per source)`);
        if (f.source.type !== 'divergence') this.#seeJob(f.source.job);
        const { kind: _k, ...rest } = f;
        this.#amendments.push({ ...rest, seq: at.seq });
        return;
      }
      case 'issue-intake': {
        if (this.#intake.some((x) => x.job === f.job && x.issue === f.issue)) fail(`a second issue-intake of ${f.issue} by ${f.job}`);
        if (f.outcome.type === 'finding' && !this.#findings.has(f.outcome.finding)) fail(`issue-intake of ${f.issue} names finding ${f.outcome.finding}, which was never opened`);
        if (f.outcome.type === 'amendment' && !this.#amendments.some((x) => x.id === (f.outcome as { amendment: string }).amendment)) {
          fail(`issue-intake of ${f.issue} names amendment ${f.outcome.amendment}, which was never recorded`);
        }
        this.#seeJob(f.job);
        const { kind: _k, ...rest } = f;
        this.#intake.push({ ...rest, seq: at.seq });
        return;
      }
      case 'pack-review-started': {
        const running = this.#packReviews.find((r) => r.ended === null);
        if (running !== undefined) fail(`pack review ${f.job} started while ${running.started.job} is running (one at a time)`);
        this.#openJob(f.job, fail);
        const { kind: _k, ...rest } = f;
        this.#packReviews.push({ started: { ...rest, seq: at.seq }, ended: null });
        return;
      }
      case 'pack-review-ended': {
        const r = this.#packReviews.find((x) => x.started.job === f.job);
        if (r === undefined || r.ended !== null) return fail(`pack-review-ended of ${f.job}, which is not running`);
        const { kind: _k, ...rest } = f;
        r.ended = { ...rest, seq: at.seq };
        return;
      }
      case 'issues-captured': {
        // Written for the checkpoint job its `checkpoint-inputs` opens next (H13): it names that job without opening it.
        const next = this.nextJobId('ckpt');
        if (f.job !== next) fail(`issues-captured for ${f.job}; the next checkpoint job is ${next}`);
        if (this.#captures.some((c) => c.job === f.job)) fail(`a second issues-captured for ${f.job}`);
        const { kind: _k, ...rest } = f;
        this.#captures.push({ ...rest, seq: at.seq });
        return;
      }
      default:
        this.#holisticFact(f, fail, at);
    }
  }

  #seeJob(job: JobId): void {
    const { kind, n } = parseJobId(job);
    if (n > (this.#jobs.get(kind) ?? 0)) this.#jobs.set(kind, n);
  }

  /** A job that opens with this fact must be its kind's next (`nextJobId`). */
  #openJob(job: JobId, fail: (detail: string) => never): void {
    const { kind } = parseJobId(job);
    const next = this.nextJobId(kind);
    if (job !== next) fail(`${job} opened; the next ${kind} job is ${next}`);
    this.#seeJob(job);
  }

  /** The M3 facts (SCHEMAS.md "M3: fold invariants"). */
  #holisticFact(f: HolisticFact, fail: (detail: string) => never, at: Readonly<{ seq: number; at: IsoTime }>): void {
    const { seq } = at;
    switch (f.kind) {
      case 'witnessed': {
        const { op, ordinal } = parseInvocationId(f.inv);
        const entry = this.#ops.get(op);
        if (entry === undefined || ordinal > entry.latest.ordinal) fail(`witnessed by ${f.inv}, which no intent opened`);
        if (f.for.type === 'job') this.#seeJob(f.for.job);
        const { kind: _k, ...rest } = f;
        this.#witnessed.push({ ...rest, seq });
        return;
      }
      case 'obligation-latched': {
        if (this.#latched.has(f.obligation)) fail(`obligation ${f.obligation} latched twice`);
        const { kind: _k, ...rest } = f;
        this.#latched.set(f.obligation, { ...rest, seq });
        return;
      }
      case 'finding-opened': {
        const next = this.nextFindingId();
        if (f.id !== next) fail(`finding ${f.id} opened; the next finding is ${next}`);
        const merged = [...this.#findings.values()].find((x) => x.key === f.key && FINDING_MOVES[x.state].length > 0);
        if (merged !== undefined) fail(`finding ${f.id} has the key of ${merged.id}, which is ${merged.state}: it merges into it`);
        if (f.source.type === 'job') this.#seeJob(f.source.job);
        const { kind: _k, ...rest } = f;
        this.#findings.set(f.id, { ...rest, state: 'open', owner: null, openedSeq: seq, last: null });
        return;
      }
      case 'finding-transition': {
        const x = this.#findings.get(f.id);
        if (x === undefined) return fail(`finding-transition of ${f.id}, which was never opened`);
        if (!FINDING_MOVES[x.state].includes(f.to.state)) fail(`finding ${f.id} moves ${x.state} → ${f.to.state}`);
        const owner = f.to.state === 'owned' || f.to.state === 'fixed-on-branch' ? f.to.unit : f.to.state === 'open' ? null : x.owner;
        this.#findings.set(f.id, { ...x, state: f.to.state, owner, last: f.to });
        return;
      }
      case 'audit-started': {
        const open = this.#audits.find((a) => a.ended === null);
        if (open !== undefined) fail(`audit ${f.job} started while ${open.started.job} is running (one audit at a time)`);
        this.#openJob(f.job, fail);
        const { kind: _k, ...rest } = f;
        this.#audits.push({ started: { ...rest, seq }, ended: null });
        return;
      }
      case 'audit-ended': {
        const a = this.#audits.find((x) => x.started.job === f.job);
        if (a === undefined || a.ended !== null) return fail(`audit-ended of ${f.job}, which is not running`);
        for (const c of f.covered) if (!a.started.lenses.includes(c.lens)) fail(`audit ${f.job} covers lens ${c.lens}, which it did not run`);
        for (const id of f.findings) if (!this.#findings.has(id)) fail(`audit ${f.job} names finding ${id}, which was never opened`);
        const { kind: _k, job: _j, ...rest } = f;
        a.ended = { ...rest, seq };
        return;
      }
      case 'docs-covered': {
        if (f.from === f.to) fail(`docs-covered of ${f.pub} is an empty edge`);
        this.#seeJob(f.pub);
        const { kind: _k, ...rest } = f;
        this.#docsCovered.push({ ...rest, seq });
        return;
      }
      case 'checkpoint-inputs': {
        if (f.issues?.type === 'captured') {
          const capture = this.#captures.find((c) => c.job === f.job);
          if (capture?.sha256 !== f.issues.sha256) fail(`checkpoint-inputs of ${f.job} names issues ${f.issues.sha256}, which no issues-captured for it records`);
        }
        this.#openJob(f.job, fail);
        const { kind: _k, ...rest } = f;
        this.#checkpoints.set(f.job, { inputs: { ...rest, seq }, decided: null });
        return;
      }
      case 'bundle-decided': {
        const c = this.#checkpoints.get(f.job);
        if (c === undefined || c.decided !== null) return fail(`bundle-decided of ${f.job}, which has no undecided checkpoint inputs`);
        c.decided = f.outcome;
        return;
      }
      case 'divergence': {
        const next = this.nextDivergenceId();
        if (f.id !== next) fail(`divergence ${f.id}; the next divergence is ${next}`);
        if (!this.#checkpoints.has(f.job)) fail(`divergence ${f.id} of ${f.job}, which is no checkpoint job`);
        if (this.#divergences.some((d) => d.job === f.job && d.index === f.index)) fail(`a second divergence ${f.job}#${f.index}`);
        const { kind: _k, ...rest } = f;
        this.#divergences.push({ ...rest, seq });
        return;
      }
      case 'divergence-digest': {
        const known = new Set(this.#divergences.map((d) => d.id));
        const bound = new Set(this.#digests.flatMap((d) => d.ids));
        for (const id of f.ids) {
          if (!known.has(id)) fail(`divergence-digest names ${id}, which was never recorded`);
          if (bound.has(id)) fail(`divergence-digest names ${id}, which an earlier digest binds (H11)`);
        }
        const { kind: _k, ...rest } = f;
        this.#digests.push({ ...rest, seq });
        return;
      }
      case 'steered': {
        const { kind: _k, ...rest } = f;
        this.#steered.push({ ...rest, seq });
        this.#steer(f, seq, fail);
        return;
      }
      case 'merged-in': {
        const { kind: _k, ...rest } = f;
        this.#mergedIn.push({ ...rest, seq });
        this.#mergeIn(f, seq, fail);
        return;
      }
      case 'audit-requested': {
        const { kind: _k, ...rest } = f;
        this.#auditRequests.push({ ...rest, seq });
        return;
      }
      case 'admissions-closed':
        if (this.#draining !== null) fail(`admissions-closed while already draining (since ${this.#draining.command})`);
        this.#draining = { command: f.command, seq };
        return;
      case 'docs-published': {
        this.#seeJob(f.pub);
        const { kind: _k, ...rest } = f;
        this.#docsPublished.push({ ...rest, seq });
        return;
      }
      case 'arc-completed': {
        if (this.#planApplied === null || f.planRev !== this.#planApplied.rev) fail(`arc-completed at plan rev ${f.planRev}; the plan in force is rev ${this.#planApplied?.rev ?? 'none'}`);
        if (f.highWater >= seq) fail(`arc-completed names high-water ${f.highWater}, not before its own seq ${seq}`);
        const { kind: _k, ...rest } = f;
        this.#completion = { ...rest, seq };
        return;
      }
    }
  }

  /**
   * A new plan in force: the next revision. Its spec edits of dispatched units take effect here: an
   * evidence-only edit is the unit's spec at once; a revision is held pending until the unit re-opens on it;
   * a withdrawn revision clears that. An edit of an undispatched unit only changes the manifest. Every edit is
   * checked before any is applied, so a refused fact leaves the fold as it was.
   */
  #planAppliedFact(f: PlanAppliedFact, seq: number, fail: (detail: string) => never): void {
    const expected = (this.#planApplied?.rev ?? 0) + 1;
    if (f.rev !== expected) fail(`plan-applied rev ${f.rev}; the next plan revision is ${expected}`);
    if (f.command !== null && this.#appliedBy.has(f.command)) fail(`a second plan-applied fact of command ${f.command}`);
    // Revision 1 comes before anything runs (the reader requires `scheduling: 'dag'` on it, and only there).
    if (f.rev === 1 && this.#dispatches.size > 0) fail('plan-applied rev 1 in a log that already dispatched a unit');
    // M3 (A5): the vision, once in force, stays; a bundle's revision is its checkpoint's decision.
    if (this.#holisticOn && f.visionSha256 === undefined) fail(`plan-applied rev ${f.rev} drops the vision (holistic may be added, never removed)`);
    const bundle = f.source.type === 'bundle' ? this.#checkpoints.get(f.source.job) : undefined;
    if (f.source.type === 'bundle' && (bundle === undefined || bundle.decided !== null)) fail(`plan-applied from bundle ${f.source.job}, which has no undecided checkpoint inputs`);
    const edits: { unit: UnitId; update: (u: UnitState) => UnitState }[] = [];
    const lineages: (() => void)[] = [];
    for (const c of f.changes) {
      if (c.type === 'unit-cut') {
        const status = this.#units.get(c.unit)?.state.status;
        if (status === 'retired' || status === 'cut' || status === 'superseded') fail(`plan-applied cuts ${c.unit}, which is ${status}`);
        edits.push({ unit: c.unit, update: (s) => ({ ...s, status: 'cut' }) });
        continue;
      }
      if (c.type === 'unit-reentered') {
        lineages.push(this.#reentry(f, c, fail));
        continue;
      }
      if (c.type !== 'spec') continue;
      if (f.specs[c.unit] !== c.specSha256) fail(`plan-applied names spec ${c.specSha256} for ${c.unit}, but its manifest ${f.specs[c.unit] ?? 'nothing'}`);
      const dispatched = this.#dispatches.has(c.unit);
      if (c.edit === 'undispatched') {
        if (dispatched) fail(`plan-applied edits the spec of ${c.unit} as undispatched, but it was dispatched`);
        continue;
      }
      if (!dispatched) fail(`plan-applied makes a ${c.edit} edit of ${c.unit}, which was never dispatched`);
      const u = this.unit(c.unit);
      const spec = u.spec;
      if (spec === null) return fail(`plan-applied edits ${c.unit}, which has no recorded spec`);
      const next = { rev: c.specRev, sha256: c.specSha256 };
      switch (c.edit) {
        case 'evidence':
          if (c.specRev !== spec.rev) fail(`an evidence-only edit of ${c.unit} at rev ${c.specRev}; its spec is at rev ${spec.rev}`);
          edits.push({ unit: c.unit, update: (s) => ({ ...s, spec: next }) });
          break;
        case 'revision':
          if (c.specRev !== spec.rev + 1) fail(`a revision of ${c.unit} at rev ${c.specRev}; its spec is at rev ${spec.rev}`);
          edits.push({ unit: c.unit, update: (s) => ({ ...s, pendingRevision: { ...next, command: f.command } }) });
          break;
        case 'withdrawn':
          if (u.pendingRevision === null) fail(`a withdrawn revision of ${c.unit}, which has none pending`);
          if (c.specSha256 !== spec.sha256) fail(`a withdrawn revision of ${c.unit} names spec ${c.specSha256}, not its recorded ${spec.sha256}`);
          edits.push({ unit: c.unit, update: (s) => ({ ...s, pendingRevision: null }) });
          break;
      }
    }
    for (const e of edits) {
      const entry = this.#unit(e.unit, 'plan-check');
      entry.state = e.update(entry.state);
    }
    for (const apply of lineages) apply();
    this.#holisticOn = f.visionSha256 !== undefined;
    if (bundle !== undefined) bundle.decided = { kind: 'applied', planRev: f.rev };
    // §2.10: an architect admit (an apply that adds units) reopens a draining arc.
    const architect = f.source.type === 'command';
    if (architect && f.changes.some((c) => c.type === 'unit-added')) this.#draining = null;
    this.#planApplied = f;
    if (f.command !== null) this.#appliedBy.set(f.command, f);
    for (const unit of Object.keys(f.specs) as UnitId[]) {
      this.#plannedUnits.add(unit);
      if (!this.#addedSeqs.has(unit)) this.#addedSeqs.set(unit, seq);
    }
  }

  /**
   * A re-entry (M2): checks now, applies (the returned thunk) once the whole fact is checked. `c.unit` is new
   * in this revision and has no state; `c.reenters` is parked or held and not already superseded. The new
   * unit starts at `prepare` with its predecessor's counters (`chargeableFailures` reset only with `reset`),
   * attempt numbering and risk floor, and the predecessor is superseded.
   */
  #reentry(f: PlanAppliedFact, c: Extract<PlanAppliedFact['changes'][number], { type: 'unit-reentered' }>, fail: (detail: string) => never): () => void {
    if (f.specs[c.unit] === undefined) fail(`plan-applied re-enters ${c.reenters} as ${c.unit}, which its manifest does not list`);
    if (this.#units.has(c.unit) || this.#dispatches.has(c.unit) || this.#plannedUnits.has(c.unit)) fail(`plan-applied re-enters ${c.reenters} as ${c.unit}, an id already used`);
    const status = this.unit(c.reenters).status;
    const old = this.#units.get(c.reenters);
    if (old === undefined || (status !== 'park-pending' && status !== 'held')) return fail(`plan-applied re-enters ${c.reenters}, which is ${status}, not parked or held`);
    return () => {
      const o = old.state;
      const fresh = newUnitState(c.unit, 'prepare', o.risk);
      const counters = c.reset ? { ...o.counters, chargeableFailures: 0 } : o.counters;
      this.#units.set(c.unit, {
        starts: new Set<string>(), outcomes: new Set<string>(), attemptBase: o.counters.attempts, beforeDecided: { decided: null, interrupted: null },
        state: { ...fresh, counters, lineage: { reenters: c.reenters, root: o.lineage?.root ?? c.reenters, prepared: false } },
      });
      old.state = { ...o, status: 'superseded', supersededBy: c.unit, park: null };
    };
  }

  /**
   * `resume <unit>` of an operator-env park (M2): the unit re-enters at the stage it parked at; its decision
   * and interruption return to what they were before the park, so the driver re-runs that stage as a new,
   * uncharged attempt. Nothing else changes.
   */
  #unpark(unit: UnitId, fail: (detail: string) => never): void {
    const u = this.#units.get(unit);
    const decided = u?.state.decided ?? null;
    const park = u?.state.park ?? null;
    if (u === undefined || u.state.status !== 'park-pending' || decided === null || park === null) return fail(`unpark of unit ${unit}, which is not parked`);
    if (park.park.class !== 'operator' || park.park.kind !== 'env') fail(`unpark of unit ${unit}, whose park is ${canonicalJson(park.park)}, not operator env`);
    this.#restoreParked(u, null);
  }

  /**
   * `steer <u>` (M3, R11): of a parked unit, or of a re-entry whose preparation decided its next stage and that has not
   * started it. The unit is active again at a steer round (`entry`), in a steer pass (`steering`); its park and any
   * approval are gone (approvals are invalidated); its decision stays, as the pre-steer state (a steer park that is
   * resumed restores the decision before that park).
   */
  #steer(f: Extract<Fact, { kind: 'steered' }>, seq: number, fail: (detail: string) => never): void {
    const u = this.#units.get(f.unit);
    if (u === undefined || this.dispatchOf(f.unit) === null) return fail(`steered unit ${f.unit}, which was never dispatched`);
    const s = u.state;
    const preparing = s.status === 'active' && s.decided?.stage === 'prepare';
    if (!(s.status === 'park-pending' || preparing) || s.open !== null || s.entry !== null) {
      fail(`steered unit ${f.unit}, which is ${s.status}${s.open === null ? '' : ` with ${s.open.stage}#${s.open.attempt} open`}, not parked or preparing`);
    }
    u.state = {
      ...s, status: 'active', park: null, interrupted: null, approval: null,
      entry: { kind: 'steer', seq, command: f.command, brief: f.brief, budgetMin: f.budgetMin, resume: f.resume }, steering: { seq, resume: f.resume },
    };
  }

  /**
   * `merge-in <u>` (M3): the integration tip was merged into the unit's branch, so its next stage is its lanes
   * (`entry`), whatever it had decided; its approval and any interruption are gone. A parked unit is active again; a
   * held one stays held until resumed.
   */
  #mergeIn(f: Extract<Fact, { kind: 'merged-in' }>, seq: number, fail: (detail: string) => never): void {
    const u = this.#units.get(f.unit);
    if (u === undefined || this.dispatchOf(f.unit) === null) return fail(`merged-in unit ${f.unit}, which was never dispatched`);
    const s = u.state;
    if (!(s.status === 'active' || s.status === 'held' || s.status === 'park-pending') || s.open !== null) fail(`merged-in unit ${f.unit}, which is ${s.status}`);
    u.state = {
      ...s, status: s.status === 'park-pending' ? 'active' : s.status, park: null, interrupted: null, approval: null,
      entry: { kind: 'merge-in', seq, command: f.command }, steering: null,
    };
  }

  /** The unit re-runs the stage its park decided at: decision and interruption as before the park. */
  #restoreParked(u: UnitEntry, recovery: UnitState['lastRecovery']): void {
    const decided = u.state.decided;
    if (decided === null) throw new Error(`restore of unit ${u.state.unit}, which decided nothing`);
    u.state = { ...u.state, stage: decided.stage, status: 'active', ...u.beforeDecided, park: null, lastRecovery: recovery ?? u.state.lastRecovery };
  }

  /**
   * A probe (M2): its result is the target's latest. A pass marks the target passed for every park it covers
   * that is still current (a stale cover, a park already recovered, resumed or re-opened, changes nothing); a
   * unit park whose every target has passed recovers, and a backend's retryable park at exactly the covered
   * seq clears, releasing the holds it caused.
   */
  #probe(f: Extract<Fact, { kind: 'probe' }>, fail: (detail: string) => never, at: Readonly<{ seq: number; at: IsoTime }>): void {
    const key = probeTargetKey(f.target);
    const recover: UnitEntry[] = [];
    const clear: Backend[] = [];
    const passed: [UnitEntry, ParkState][] = [];
    for (const seq of f.covers) {
      const failed = this.#failSeqs.get(seq);
      if (failed !== undefined) {
        // A residue's cover: its fail transition, which recovers nothing (the reclaim order already ran).
        if (f.target.type !== 'resource' || !failed.includes(f.target.instance)) fail(`probe of ${key} covers the failed cleanup at seq ${seq}, which left no residue on it`);
        continue;
      }
      const unit = this.#unitParkSeqs.get(seq);
      const backend = this.#backendParkSeqs.get(seq);
      if (unit === undefined && backend === undefined) return fail(`probe of ${key} covers seq ${seq}, which parked nothing`);
      if (backend !== undefined) {
        if (f.target.type !== 'backend' || f.target.backend !== backend) fail(`probe of ${key} covers backend ${backend}'s park at seq ${seq}`);
        const cur = this.#backendParks.get(backend);
        if (f.result === 'pass' && cur?.seq === seq && (RETRYABLE_BACKEND_PARKS as readonly string[]).includes(cur.class)) clear.push(backend);
        continue;
      }
      const u = this.#units.get(unit as UnitId) as UnitEntry;
      const park = u.state.park;
      if (park === null || park.seq !== seq) continue;
      if (park.park.class !== 'retryable') return fail(`probe of ${key} covers unit ${u.state.unit}'s ${park.park.class} park at seq ${seq}`);
      if (!park.park.targets.some((t) => probeTargetKey(t) === key)) fail(`probe of ${key} covers unit ${u.state.unit}'s park at seq ${seq}, which does not target it`);
      if (f.result !== 'pass' || park.passed.some((t) => probeTargetKey(t) === key)) continue;
      const next = { ...park, passed: [...park.passed, f.target].sort((a, b) => (probeTargetKey(a) < probeTargetKey(b) ? -1 : 1)) };
      if (next.passed.length === park.park.targets.length) recover.push(u);
      else passed.push([u, next]);
    }
    this.#probes.set(key, { ...f, seq: at.seq, at: at.at });
    for (const [u, park] of passed) u.state = { ...u.state, park };
    for (const u of recover) {
      const park = u.state.park as ParkState;
      this.#restoreParked(u, { at: at.at, targets: park.park.class === 'retryable' ? park.park.targets : [] });
    }
    for (const backend of clear) {
      const seq = (this.#backendParks.get(backend) as BackendParkState).seq;
      this.#backendParks.delete(backend);
      this.#releaseBackendHolds(backend, seq);
    }
  }

  /**
   * Releases the holds `backend`'s parks caused (G5): a hold whose cause is that backend at a park seq up to
   * `seq`. Operator pauses are kept.
   */
  #releaseBackendHolds(backend: Backend, seq: number): void {
    if (this.#pausedAll) return;
    for (const [id, u] of this.#units) {
      if (u.state.status !== 'held' || this.#pausedUnits.has(id)) continue;
      const cause = u.state.interrupted?.cause;
      if (cause !== undefined && cause.backend === backend && cause.parkSeq <= seq) u.state = { ...u.state, status: 'active' };
    }
  }

  /**
   * A reopen: of a unit parked at a judgment stage, or of an active unit on its pending revision (the driver,
   * at a stage boundary), onto the spec rev after the one the log recorded. A pending revision must be the
   * one re-opened on (a reopen written before revisions were applied has none). The unit starts over at
   * plan-check (no decided outcome) with its counters, routed-up seats and branch kept; the redirect bound
   * counts from here.
   */
  #reopened(f: Extract<Fact, { kind: 'reopened' }>, fail: (detail: string) => never): void {
    const u = this.#units.get(f.unit);
    if (u === undefined) return fail(`reopen of unit ${f.unit}, which never started`);
    const decided = u.state.decided;
    const pending = u.state.pendingRevision;
    if (u.state.status === 'park-pending') {
      if (decided === null || !(JUDGMENT_STAGES as readonly Stage[]).includes(decided.stage)) fail(`reopen of unit ${f.unit}, parked at ${decided?.stage}, not at a judgment stage`);
    } else if (u.state.status !== 'active' || pending === null) {
      fail(`reopen of unit ${f.unit}, which is ${u.state.status} without a pending revision`);
    }
    if (pending !== null && (pending.rev !== f.specRev || pending.sha256 !== f.specSha256)) {
      fail(`reopen of unit ${f.unit} on spec ${f.specSha256} at rev ${f.specRev}; its pending revision is ${pending.sha256} at rev ${pending.rev}`);
    }
    const spec = u.state.spec;
    if (spec === null || f.specRev !== spec.rev + 1) fail(`reopen of unit ${f.unit} at spec rev ${f.specRev}; its recorded rev is ${spec?.rev ?? 'none'}`);
    u.state = {
      ...u.state, stage: 'plan-check', status: 'active', decided: null, interrupted: null, park: null, spec: { rev: f.specRev, sha256: f.specSha256 },
      reopened: { command: f.command, specRev: f.specRev }, redirectBase: u.state.counters.redirects, pendingRevision: null,
    };
  }

  /**
   * A resume clears holds without touching counters, so the next stage start is a new, uncharged attempt.
   * `unit`: that unit's pause and hold (refused while the whole arc is paused). `all`: every pause and every
   * hold. `backend`: that backend's current park, whatever its class, and the holds it caused (G5).
   */
  #resumed(target: Extract<Fact, { kind: 'resumed' }>['target'], fail: (detail: string) => never): void {
    const release = (u: UnitEntry): void => {
      if (u.state.status === 'held') u.state = { ...u.state, status: 'active' };
    };
    switch (target.type) {
      case 'unit': {
        if (this.#pausedAll) fail(`resume of unit ${target.unit} while the whole arc is paused`);
        this.#pausedUnits.delete(target.unit);
        const u = this.#units.get(target.unit);
        if (u !== undefined) release(u);
        return;
      }
      case 'all':
        this.#pausedAll = false;
        this.#pausedUnits.clear();
        for (const u of this.#units.values()) release(u);
        return;
      case 'backend': {
        const park = this.#backendParks.get(target.backend);
        if (park === undefined) return fail(`resume of backend ${target.backend}, which is not parked`);
        this.#backendParks.delete(target.backend);
        this.#releaseBackendHolds(target.backend, park.seq);
        return;
      }
    }
  }

  /** Every counter the fold derives, flattened, for the `monotonic()` check around each event. */
  #counters(): Record<string, number> {
    const out: Record<string, number> = { lastSeq: this.#lastSeq, snapshotHighWater: this.#snapshotHighWater };
    for (const [unit, { state: { counters: c, routedUp } }] of this.#units) {
      out[`unit ${unit} attempts`] = c.attempts;
      out[`unit ${unit} chargeableFailures`] = c.chargeableFailures;
      out[`unit ${unit} redirects`] = c.redirects;
      out[`unit ${unit} reviseRounds`] = c.reviseRounds;
      out[`unit ${unit} candidateReds`] = c.candidateReds;
      for (const s of RETRY_STAGES) out[`unit ${unit} retries ${s}`] = c.retries[s];
      out[`unit ${unit} routedUp`] = routedUp.length;
    }
    for (const [key, m] of this.#meter) {
      out[`meter ${key} known`] = m.known;
      out[`meter ${key} unavailable`] = m.unavailable;
      out[`meter ${key} inputTokens`] = m.inputTokens;
      out[`meter ${key} outputTokens`] = m.outputTokens;
      out[`meter ${key} cacheReadTokens`] = m.cacheReadTokens;
      out[`meter ${key} cacheWriteTokens`] = m.cacheWriteTokens;
      out[`meter ${key} turns`] = m.turns;
      out[`meter ${key} costUsd`] = m.costUsd;
    }
    return out;
  }

  // JournalView ---------------------------------------------------------------------------------------

  highWater(): number {
    return this.#lastSeq;
  }

  openIntents(): readonly IntentRecord[] {
    return [...this.#open.values()];
  }

  latestIntent(op: OpId): IntentRecord {
    const entry = this.#ops.get(op);
    if (entry === undefined) throw new Error(`latestIntent: no intent for op ${op} in the log of arc ${this.arc}`);
    return entry.latest;
  }

  doneOf(op: OpId): DoneRecord | null {
    const entry = this.#ops.get(op);
    if (entry === undefined) throw new Error(`doneOf: no intent for op ${op} in the log of arc ${this.arc}`);
    return entry.closure?.type === 'done' ? entry.closure.record : null;
  }

  opsOf<K extends OpKind>(kind: K): readonly IntentOf<K>[] {
    const out: IntentOf<K>[] = [];
    for (const { latest } of this.#ops.values()) if (latest.kind === kind) out.push(latest as IntentOf<K>);
    return out;
  }

  usageRecorded(inv: InvocationId): boolean {
    return this.#metered.has(inv);
  }

  unit(unit: UnitId): UnitState {
    return this.#units.get(unit)?.state ?? this.#fresh(unit, 'plan-check');
  }

  dispatchOf(unit: UnitId): DispatchRecord | null {
    return this.#dispatches.get(unit)?.at(-1) ?? null;
  }

  dispatchesOf(unit: UnitId): readonly DispatchRecord[] {
    return this.#dispatches.get(unit) ?? [];
  }

  parkedBackends(): readonly Backend[] {
    return [...this.#backendParks.keys()].sort(compare);
  }

  backendParks(): readonly BackendParkState[] {
    return [...this.#backendParks.values()].sort((a, b) => compare(a.backend, b.backend));
  }

  resources(): ReadonlyMap<ResourceUnit, ResourceEntry> {
    return this.#resources;
  }

  residues(): readonly ResidueState[] {
    return [...this.#residues].sort(([a], [b]) => compareResourceUnits(a, b)).map(([, r]) => r);
  }

  probes(): readonly ProbeState[] {
    return [...this.#probes].sort(([a], [b]) => compare(a, b)).map(([, p]) => p);
  }

  judgmentInputs(unit: UnitId, stage: JudgmentStage, attempt: number): JudgmentInputs | null {
    return this.#judgmentInputs.get(`${unit} ${stage}#${attempt}`) ?? null;
  }

  edgeResolved(edge: EdgeId): EdgeResolvedState | null {
    return this.#resolvedEdges.get(edge) ?? null;
  }

  runOnly(): readonly UnitId[] | null {
    return this.#runOnly;
  }


  needsUser(): readonly NeedsUserState[] {
    return [...this.#needsUser].sort(([a], [b]) => compare(a, b)).map(([id, { blocking }]) => ({ id, blocking, ack: this.#acks.get(id) ?? null }));
  }

  ackOf(id: NeedsUserId): NeedsUserAckState | null {
    return this.#acks.get(id) ?? null;
  }

  control(): ControlState {
    return { stop: this.#stop, pausedAll: this.#pausedAll, pausedUnits: [...this.#pausedUnits].sort(compare) };
  }

  containmentMode(): ContainmentMode | null {
    return this.#containmentMode;
  }

  planApplied(): PlanAppliedFact | null {
    return this.#planApplied;
  }

  planAppliedBy(command: CommandId): PlanAppliedFact | null {
    return this.#appliedBy.get(command) ?? null;
  }

  decidedSeq(unit: UnitId): number | null {
    const d = this.unit(unit).decided;
    if (d === null) return null;
    const seq = this.#outcomeSeqs.get(`${unit}/${d.stage}#${d.attempt}`);
    if (seq === undefined) throw new Error(`unit ${unit}'s decided outcome ${d.stage}#${d.attempt} has no seq`);
    return seq;
  }

  publications(): readonly Readonly<{ unit: UnitId; seq: number }>[] {
    return this.#publications;
  }

  addedSeq(unit: UnitId): number | null {
    return this.#addedSeqs.get(unit) ?? null;
  }

  plannedUnits(): readonly UnitId[] {
    return [...this.#plannedUnits].sort(compare);
  }

  // M3 ------------------------------------------------------------------------------------------------

  nextFindingId(): FindingId {
    return findingIdOf(this.#findings.size + 1);
  }

  nextDivergenceId(): DivergenceId {
    return divergenceIdOf(this.#divergences.length + 1);
  }

  /** M4a: the id the next `corpus-amendment` must carry (`M-<amendments + 1>`, arc-scoped). */
  nextAmendmentId(): AmendmentId {
    return amendmentIdOf(this.#amendments.length + 1);
  }

  nextJobId(kind: JobKind): JobId {
    return jobId(kind, (this.#jobs.get(kind) ?? 0) + 1);
  }

  integrationHead(): Sha | null {
    return this.#head;
  }

  lastWorkSeq(): number {
    return this.#lastWorkSeq;
  }

  holistic(): HolisticFold {
    const c = this.#completion;
    const active = c !== null && this.#planApplied?.rev === c.planRev && (this.#head === null || this.#head === c.head) && this.#lastReopenSeq < c.seq;
    return {
      on: this.#holisticOn,
      witnessed: this.#witnessed,
      latched: [...this.#latched.values()],
      findings: [...this.#findings.values()],
      audits: this.#audits.map((a) => ({ started: a.started, ended: a.ended })),
      auditRequests: this.#auditRequests,
      docsCovered: this.#docsCovered,
      docsPublished: this.#docsPublished,
      checkpoints: [...this.#checkpoints.values()].map((x) => ({ inputs: x.inputs, decided: x.decided })),
      divergences: this.#divergences,
      digests: this.#digests,
      steered: this.#steered,
      mergedIn: this.#mergedIn,
      debt: this.#debt,
      amendments: this.#amendments,
      intake: this.#intake,
      packReviews: this.#packReviews.map((r) => ({ started: r.started, ended: r.ended })),
      captures: this.#captures,
      draining: this.#draining,
      completion: c === null ? null : { ...c, active },
    };
  }

  derived(): DerivedState {
    return {
      v: SCHEMA_VERSION,
      arc: this.arc,
      plan: this.#planApplied === null ? null : { rev: this.#planApplied.rev, planSha256: this.#planApplied.planSha256 },
      lastSeq: this.#lastSeq,
      snapshotHighWater: this.#snapshotHighWater,
      openIntents: this.openIntents(),
      units: [...this.#units].sort(([a], [b]) => compare(a, b)).map(([, u]) => u.state),
      meter: [...this.#meter].sort(([a], [b]) => compare(a, b)).map(([, m]) => ({ ...m })),
      needsUser: [...this.#needsUser.keys()].sort(compare),
      needsUserBlocking: [...this.#needsUser].filter(([, n]) => n.blocking).map(([id]) => id).sort(compare),
      needsUserAcked: [...this.#acks.keys()].sort(compare),
      control: this.control(),
      containmentMode: this.#containmentMode,
      tailDiscarded: [...this.#tail],
      parkedBackends: this.parkedBackends(),
      backendParks: this.backendParks(),
      resources: [...this.#resources].sort(([a], [b]) => compareResourceUnits(a, b)).map(([unit, e]) => ({ unit, status: e.status, pending: e.pending?.op ?? null })),
      runOnly: this.#runOnly,
      resolvedEdges: [...this.#resolvedEdges.keys()].sort(compare),
      holistic: this.holistic(),
    };
  }
}

/** The highest-attempt start of a unit when it has no outcome yet (`UnitState.open`). */
function openStart(u: UnitEntry): UnitState['open'] {
  let latest: { stage: Stage; attempt: number } | null = null;
  for (const key of u.starts) {
    const at = key.lastIndexOf('#');
    const attempt = Number(key.slice(at + 1));
    if (latest === null || attempt > latest.attempt) latest = { stage: key.slice(0, at) as Stage, attempt };
  }
  return latest === null || u.outcomes.has(`${latest.stage}#${latest.attempt}`) ? null : latest;
}

function retryable(closure: Closure): boolean {
  return closure.type === 'abort' || closure.record.outcome.kind === 'lost';
}

function closureName(closure: Closure): string {
  return closure.type === 'abort' ? 'abort' : `done ${closure.record.outcome.kind}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The pure fold over a whole ordered log. The journal folds incrementally with `Fold` instead. */
export function fold(arc: ArcId, events: readonly Event[]): DerivedState {
  const f = new Fold(arc);
  for (const event of events) f.apply(event, prevHash(Buffer.from(serializeEvent(event), 'utf8')));
  return f.derived();
}

/** Rewrites the `state.json` cache. Deliberately write-only: decisions come from the fold, never from here. */
export function writeStateCache(path: string, state: DerivedState): void {
  atomicJson(path, state);
}
