// The fold: the one derivation of run state from the event log. Everything the executor knows about ops,
// units, spend and needs-user comes from folding events.jsonl in order. `state.json` exists only in
// the snapshot tree, derived from that snapshot's log prefix, and is never read back for a decision.
//
// The fold also enforces the log's invariants (SCHEMAS.md "Event log"): a violation throws
// FoldInvariantError. At open the journal turns that into a refusal (`log-corrupt`); at append it means
// the caller asked for an illegal record, and nothing is written.
import {
  type AbortRecord, type AuditInputs, type BackendParkClass, type CoveredRange, type DoneRecord, type Event, type Fact, type HolisticFact, type Holder,
  type IntentOf, type IntentRecord, type JudgmentInputs, type JudgmentStage, type OpKind, type Parent, type ParkRecord, type PlanAppliedFact, type ProbeTarget,
  type ResourceEdge, type RetryStage, type ScopeGrowthProposal, type StageOutcomeFact, JUDGMENT_STAGES, RECLAIM_HOLDERS, RESIDUE_HOLDERS, RETRY_STAGES, RETRYABLE_BACKEND_PARKS,
  prevHash, probeTargetKey, serializeEvent, certificationRed,
} from './events.ts';
import { checkpointSkipTriggerOf, dev31UnchargedLanesRedsDefault } from './upgrade.ts';
import { CounterRegressionError } from './fsx.ts';
import {
  type AmendmentId, type ArcId, type ClaudeSessionId, type CommandId, type DivergenceId, type EdgeId, type FindingId, type InvocationId, type JobId, type JobKind, type NeedsUserId, type ObligationId,
  type MilestoneId, type OpId, type OpKey, type PlanRev, type PolishId, type ResourceInstance, type ResourceUnit, type RoutingRev, type Sha, type Sha256Hex, type SpecRev, type UnitId,
  JOB_KINDS, amendmentIdOf, compareResourceUnits, divergenceIdOf, findingIdOf, jobId, parseInvocationId, parseJobId, parseOpId, polishIdOf,
  type ReviewFindingId, reviewFindingIdOf,
} from './ids.ts';
import type { ControlState, FlowFactAt, JournalView, NeedsUserAckState, NeedsUserState, PropagationFactAt, WalkFactAt, FlakeAt } from './interfaces.ts';
import { causeKey } from './stale.ts';
import type { ApprovalBlobs, FindingsLedgerEntry } from './review.ts';
import { canonicalJson } from './json.ts';
import { type SessionCharge, addCharged } from './usage.ts';
import { type ApprovalFingerprint, type Bounds, type ContainmentMode, type DispatchRecord, type ResidueKey, type Stage, DEFAULT_BOUNDS, boundsOfRecord } from './records.ts';
import { type BundleOutcome, type FindingStateName, type FindingTo, FINDING_MOVES } from '../holistic/types.ts';
import type { IsoTime } from './values.ts';
import { SCHEMA_VERSION, type SchemaVersion } from './version.ts';
import { type Backend, RISK_TIERS, type RiskTier, type Role, type UnitRole } from '../routing/types.ts';

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

/** Per-unit counters: cumulative except the resettable certification allowance. */
export type UnitCounters = Readonly<{
  /** Stage starts: distinct (stage, attempt) pairs named by a stage-parented intent or a stage-outcome fact. */
  attempts: number;
  chargeableFailures: number;
  /** Certification reds since the last charge; reset on a charge, initially 0. */
  unchargedLanesReds: number;
  /** Plan-check redirects applied. */
  redirects: number;
  /** Gate revise rounds taken. */
  reviseRounds: number;
  /** Red candidates sent back to a fix round. */
  candidateReds: number;
  /** M4a rev 3 (D2): mutation-smoke fix rounds taken (0 for a unit folded from a 1.0.0-dev.6 log: none spent). */
  smokeRounds: number;
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
   * src/pipeline/rounds.ts); a chain of pauses keeps the latest. A recovery hold (`cause: recovery`) is not one: it
   * leaves this as it was.
   */
  interrupted: StageOutcomeFact | null;
  /**
   * M4b rev 3 (RC-11): the unit's latest host-pressure hold while no later outcome has decided (a pause hold since keeps
   * it): the run it was held for, and when. Admission holds the stage's re-run until a minute of scheduler ticks since the hold shows the host's cpu wait below `PRESSURE_SATURATED`
   * or `STARVED_HOLD_MS` pass (src/schedule/ready.ts), and that re-run is the one rerun a red under
   * pressure gets. A host-pressure hold leaves the unit `active`: it waits on admission, not on a resume. Null otherwise.
   */
  pressureHold: Readonly<{ inv: InvocationId; at: IsoTime }> | null;
  /** M4b rev 3 (RC-11): the unit's host-pressure holds so far; from `STARVED_MAX` on its runs are charged as without pressure. */
  pressureHolds: number;
  /** The latest gate approval: its attempt and the fingerprint it binds to; null before one. */
  approval: Readonly<{ attempt: number; fingerprint: ApprovalFingerprint }> | null;
  /**
   * The latest stage start (highest attempt) while no stage-outcome fact records it: an attempt a crash cut
   * short, whose invocations recovery has since closed (the driver consumes a completed backend call instead
   * of dispatching again, unit.ts), or a retire, which records no outcome. Null once it has its outcome. `seq`: the
   * seq of the record that first started it (M4a rev 3: `openAttempt` tells a running attempt from an abandoned one).
   * Arc feedback 2026-10-15: the executor's startup records every abandoned one at an admission stage (its call, or a
   * recovery hold), so past startup only a running attempt, or a chain stage's about to run again, is open.
   */
  open: Readonly<{ stage: Stage; attempt: number; seq: number }> | null;
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
   * dev.17 (propagation): the latest stale set (its plan rev) naming a link of the unit that no plan-check of it has answered
   * since (`stale-answered`); null when none. An in-flight unit re-opens at plan-check on it (`stale-reopened`).
   */
  staleRev: PlanRev | null;
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
   * The implementer's seat tier (A11): the risk floor, or `high` once a dev.16 `implementer-escalated` fact moved it (D4,
   * retired in dev.17: none is written now); null before the first dispatch. The routing-changed check compares against
   * `build.<buildTier>`.
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
  /**
   * Scope growth (2026-10-15): the root agent's decisions on the unit's held scope-growth proposals (`scope-decided`), in log
   * order, each with the proposals its plan-check attempt held. A later plan-check reads the rejected ones (it is told not
   * to propose them again, and a proposal of a rejected pattern no longer holds it).
   */
  scopeDecisions: readonly ScopeDecision[];
  /**
   * Arc feedback 2026-10-16: the unit's failure outcomes in log order, each a `stage-outcome` that parked or stopped it or
   * was charged. A re-entry's `fixes` names one of these (or a lane failure, src/pipeline/failures.ts), which the
   * classifier resolves (src/input/classify.ts `reentryRow`). Derived from the log alone.
   */
  failures: readonly FailedOutcome[];
  /**
   * dev.17 (design pass): the proofs of concept the unit has run (its `poc` stage outcomes that went back to plan-check), which
   * code bounds per unit (src/pipeline/design.ts `POC_LIMIT`). Derived from the log alone; a reopen keeps it.
   */
  pocs: number;
}>;

/**
 * A unit's latest approval as the review fold keeps it (never cleared by a park or re-entry): its blobs, null on a dev.16
 * one, and its log position (`seq`: the stale sets recorded after it changed what it bound, src/pipeline/review.ts).
 */
export type ReviewApproval = Readonly<{ seq: number; attempt: number; fingerprint: ApprovalFingerprint; blobs: ApprovalBlobs | null }>;
type DocsOnlyFact = Extract<Fact, Readonly<{ kind: 'docs-only' }>>;

/** dev.17 proportional review (SCHEMAS.md "Proportional review"): what `JournalView.review()` folds. */
export type ReviewFold = Readonly<{
  /** Every ledger finding in id order, at its current outcome. */
  ledger: readonly FindingsLedgerEntry[];
  nextFindingId: ReviewFindingId;
  /** The findings gate attempt `attempt` of `unit` minted, by their place in its answer; null before its `review-ledger`. */
  ledgered: (unit: UnitId, attempt: number) => readonly Readonly<{ index: number; id: ReviewFindingId }>[] | null;
  approval: (unit: UnitId) => ReviewApproval | null;
  /** The unit's latest lanes attempt that ended green (its salvage SHA is that attempt's spec series' commit); null before one. */
  greenLanes: (unit: UnitId) => number | null;
  docsOnly: readonly (DocsOnlyFact & Readonly<{ seq: number }>)[];
}>;

/** One failure outcome of a unit (`UnitState.failures`): the fact, its seq and the park it recorded. */
export type FailedOutcome = Readonly<{
  seq: number;
  fact: StageOutcomeFact;
  /** The park it recorded (classed as `park` reads it), on a parking outcome; else null. */
  park: ParkRecord | null;
}>;

/** One `scope-decided` fact with the proposals of the plan-check attempt it decided. */
export type ScopeDecision = Readonly<{
  /** The stage whose `scope-growth` hold it decided (plan defects, 2026-10-16: a lanes attempt's too). */
  stage: ScopeHoldStage;
  attempt: number; command: CommandId; decision: 'accepted' | 'rejected'; proposals: readonly ScopeGrowthProposal[]; reason: string;
}>;

/** The stages a `scope-growth` hold is recorded at: a plan-check's proposal, and a lanes attempt's repeated reverts. */
export const SCOPE_HOLD_STAGES = ['plan-check', 'lanes'] as const;
export type ScopeHoldStage = (typeof SCOPE_HOLD_STAGES)[number];
/** `stage` as a scope-hold stage, or null. */
export const scopeHoldStage = (stage: Stage): ScopeHoldStage | null => (SCOPE_HOLD_STAGES as readonly Stage[]).includes(stage) ? stage as ScopeHoldStage : null;

export function newUnitState(unit: UnitId, stage: Stage, risk: RiskTier | null, spec: SpecState | null = null, bounds: Bounds = DEFAULT_BOUNDS): UnitState {
  const retries = Object.fromEntries(RETRY_STAGES.map((s) => [s, 0])) as Record<RetryStage, number>;
  return {
    unit, stage, risk, status: 'active', routedUp: [], promotion: false, decided: null, interrupted: null, pressureHold: null, pressureHolds: 0,
    approval: null, open: null, counters: { attempts: 0, chargeableFailures: 0, unchargedLanesReds: 0, redirects: 0, reviseRounds: 0, candidateReds: 0, smokeRounds: 0, retries },
    spec, reopened: null, pendingRevision: null, staleRev: null, redirectBase: 0,
    park: null, lastRecovery: null, buildTier: risk, lineage: null, supersededBy: null, bounds, entry: null, steering: null, scopeDecisions: [], failures: [],
    pocs: 0,
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
export function afterStageOutcome(u: UnitState, f: Pick<StageOutcomeFact, 'stage' | 'outcome' | 'class' | 'chargeable' | 'unchargedLanesReds'>): UnitState {
  const c = u.counters;
  const add = (cls: StageOutcomeFact['class']): number => (f.class === cls ? 1 : 0);
  const judgment = (JUDGMENT_STAGES as readonly Stage[]).includes(f.stage);
  return {
    ...u,
    stage: f.stage,
    pocs: u.pocs + (f.stage === 'poc' && f.class === 'advance' ? 1 : 0),
    counters: {
      ...c,
      chargeableFailures: c.chargeableFailures + (f.chargeable ? 1 : 0),
      unchargedLanesReds: certificationRed(f.stage, f.outcome)
        ? f.unchargedLanesReds ?? dev31UnchargedLanesRedsDefault() : f.chargeable ? 0 : c.unchargedLanesReds,
      redirects: c.redirects + add('redirect'),
      reviseRounds: c.reviseRounds + add('revise'),
      candidateReds: c.candidateReds + add('candidate-red'),
      smokeRounds: c.smokeRounds + add('smoke'),
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

/**
 * A unit's open stage attempt (M4a rev 3, C5, R50): its latest stage start without an outcome, `live` when that start is
 * after the latest `executor-started` (it is running under this executor), else crash-abandoned (it waits for the
 * driver's re-run). Null when none is open, and for a retired, cut or superseded unit.
 */
export type OpenAttempt = Readonly<{ stage: Stage; attempt: number; live: boolean }>;
export function openAttempt(view: JournalView, unit: UnitId): OpenAttempt | null {
  const u = view.unit(unit);
  if (u.open === null || u.status === 'retired' || u.status === 'cut' || u.status === 'superseded') return null;
  return { stage: u.open.stage, attempt: u.open.attempt, live: u.open.seq > view.lastExecutorStarted() };
}

/** dev.17: an `apply` the scheduler queued behind a running stage (`apply-queued`): the fact's seq and the units it waits on. */
export type ApplyQueued = Readonly<{ seq: number; waitsFor: readonly UnitId[] }>;

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
/** M4a: a pack review job: its kept inputs' fact, and its end (null while running). */
export type PackReviewState = Readonly<{ started: M4aFactOf<'pack-review-started'>; ended: M4aFactOf<'pack-review-ended'> | null }>;

/** A finding as the log last moved it. `owner`: the unit of its latest `owned` or `fixed-on-branch` move. */
export type FindingState = Omit<FactOf<'finding-opened'>, 'kind'> & Readonly<{
  state: FindingStateName;
  owner: UnitId | null;
  openedSeq: number;
  /** The latest move's target (null while never moved). */
  last: FindingTo | null;
}>;

type FindingAt = Readonly<{ seq: number; finding: FindingState }>;

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
  /** Arc feedback 2026-10-16: the completed audits whose checkpoint was not run, having found nothing new, in log order. */
  checkpointSkips: readonly (Omit<FactOf<'checkpoint-skipped'>, 'kind'> & Seq)[];
  divergences: readonly (Omit<FactOf<'divergence'>, 'kind'> & Seq)[];
  digests: readonly (Omit<FactOf<'divergence-digest'>, 'kind'> & Seq)[];
  steered: readonly (Omit<FactOf<'steered'>, 'kind'> & Seq)[];
  mergedIn: readonly (Omit<FactOf<'merged-in'>, 'kind'> & Seq)[];
  /** M4a (R7): the debt this arc banked, in log order; one per source, id and key (src/debt/mint.ts `mintDebt`). */
  debt: readonly BankedDebt[];
  /** M4a: the corpus amendments, in id order (src/holistic/amendments.ts). */
  amendments: readonly AmendmentState[];
  /** M4a: the pack reviews, in job order; at most one running (src/holistic/packreview.ts). */
  packReviews: readonly PackReviewState[];
  /** `close-admissions` latched and no architect admit since (§2.10). */
  draining: Readonly<{ command: CommandId; seq: number }> | null;
  completion: CompletionState | null;
  /** M4a rev 3 (F1a): lane reuses, in log order. */
  laneReuses: readonly LaneReuseState[];
  /** M4a rev 3 (Q12): series certificates, in log order. */
  certificates: readonly CertificateState[];
  /** M4a rev 3 (D2): mutation smoke runs, in log order. */
  smokeRuns: readonly SmokeRunState[];
  /** M4a rev 3 (H7): cross-lens corroborations, in log order. */
  corroborations: readonly CorroborationState[];
}>;

/** M4a rev 3: a lane a series reused (F1a), keyed `(parent, lane)`. */
export type LaneReuseState = M4aFactOf<'lane-reused'>;
/** M4a rev 3: a series' clean certificate (Q12); absence is unknown, never clean. */
export type CertificateState = M4aFactOf<'series-certified'>;
/** M4a rev 3: a unit attempt's mutation smoke (D2), one per attempt. */
export type SmokeRunState = M4aFactOf<'smoke-ran'>;
/** M4a rev 3: a second lens's rationale merged into a finding (H7). */
export type CorroborationState = M4aFactOf<'finding-corroborated'>;

/** Records after which the arc is not sealed (A20, H5): every record but these quiet ones is work. */
function isWork(record: Event): boolean {
  if (record.type === 'fact') {
    const k = record.fact.kind;
    return !['executor-started', 'containment-mode', 'tail-discarded', 'arc-completed', 'docs-published', 'probe', 'backend-park', 'meter', 'usage-unavailable'].includes(k);
  }
  if (record.type === 'intent') return record.parent.type === 'stage' || record.parent.type === 'job' || record.parent.type === 'command' || record.kind === 'revision.commit';
  return false;
}

/** The fold's result, also written as `state.json` in snapshot trees. Sets are sorted arrays. */
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
type OpEntry = { latest: IntentRecord; closure: Closure | null; seq: number; parentKey: string };

/**
 * Op lists in first-intent order. Retries replace the same entry; a changed spawn subject can move an old
 * op into another list, so that list is sorted by its original seq on its next read. Published arrays keep
 * their values across appends, just as a full scan did. Reads between intents reuse the same readonly array.
 */
class OpIndex<K> {
  readonly #buckets = new Map<K, { entries: Map<OpId, OpEntry>; snapshot: readonly IntentRecord[] | null; ordered: boolean; lastSeq: number }>();

  set(key: K, entry: OpEntry): void {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = { entries: new Map(), snapshot: null, ordered: true, lastSeq: 0 };
      this.#buckets.set(key, bucket);
    }
    if (!bucket.entries.has(entry.latest.op)) {
      if (entry.seq < bucket.lastSeq) bucket.ordered = false;
      bucket.lastSeq = Math.max(bucket.lastSeq, entry.seq);
    }
    bucket.entries.set(entry.latest.op, entry);
    bucket.snapshot = null;
  }

  delete(key: K, op: OpId): void {
    const bucket = this.#buckets.get(key)!;
    bucket.entries.delete(op);
    bucket.snapshot = null;
    if (bucket.entries.size === 0) this.#buckets.delete(key);
  }

  get(key: K): readonly IntentRecord[] {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined) return [];
    if (bucket.snapshot === null) {
      const entries = [...bucket.entries.values()];
      if (!bucket.ordered) entries.sort((a, b) => a.seq - b.seq);
      bucket.snapshot = entries.map((entry) => entry.latest);
    }
    return bucket.snapshot;
  }
}

/** `starts` and `outcomes` hold `<stage>#<attempt>`; `state.counters.attempts` is `starts.size`. */
/** `beforeDecided`: the unit's decision and interruption before its latest decided outcome (a reroute restores them). */
/** `attemptBase`: the attempts a re-entered unit inherits from its lineage (0 otherwise). */
type UnitEntry = {
  /** Stable insertion order in the unit table (also excludes units first created by the current event). */
  order: number;
  /** Each start `<stage>#<attempt>`, with the seq of the record that first started it. */
  starts: Map<string, number>; outcomes: Set<string>; state: UnitState; attemptBase: number;
  /** Highest numbered attempt, with the first start winning ties across stages (the full-scan order). */
  latestStart: UnitState['open'];
  beforeDecided: Readonly<{ decided: StageOutcomeFact | null; interrupted: StageOutcomeFact | null }>;
};

/**
 * The records the fold's counters live in, by reference: each unit's state and each meter total is immutable and
 * replaced whenever a counter in it moves, so between two captures only a replaced (or vanished) record can have moved.
 */
export type CounterRefs = Readonly<{
  lastSeq: number;
  snapshotHighWater: number;
  units: ReadonlyMap<UnitId, UnitState>;
  meter: ReadonlyMap<string, MeterTotal>;
}>;

const UNIT_COUNTERS = ['attempts', 'chargeableFailures', 'redirects', 'reviseRounds', 'candidateReds', 'smokeRounds'] as const;
const METER_COUNTERS = ['known', 'unavailable', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'turns', 'costUsd'] as const;

/**
 * Checks the same counters and reports the same first regression as `monotonic()`. The fold supplies only
 * the records an event replaced; callers with complete snapshots may also use this to detect vanished records.
 * Counter names are formatted only on failure, and unchanged immutable counter records need no comparison.
 */
export function monotonicSince(before: CounterRefs, after: CounterRefs): void {
  for (const key of ['lastSeq', 'snapshotHighWater'] as const) {
    if (after[key] < before[key]) throw new CounterRegressionError(key, before[key], after[key]);
  }
  for (const [unit, previous] of before.units) {
    const next = after.units.get(unit);
    if (next === previous) continue;
    if (next?.counters !== previous.counters) {
      for (const key of UNIT_COUNTERS) {
        const was = previous.counters[key];
        const now = next?.counters[key];
        if (now === undefined || now < was) throw new CounterRegressionError(`unit ${unit} ${key}`, was, now);
      }
      if (next?.counters.retries !== previous.counters.retries) {
        for (const stage of RETRY_STAGES) {
          const was = previous.counters.retries[stage];
          const now = next?.counters.retries[stage];
          if (now === undefined || now < was) throw new CounterRegressionError(`unit ${unit} retries ${stage}`, was, now);
        }
      }
    }
    const was = previous.routedUp.length;
    const now = next?.routedUp.length;
    if (now === undefined || now < was) throw new CounterRegressionError(`unit ${unit} routedUp`, was, now);
  }
  for (const [key, previous] of before.meter) {
    const next = after.meter.get(key);
    if (next === previous) continue;
    for (const counter of METER_COUNTERS) {
      const was = previous[counter];
      const now = next?.[counter];
      if (now === undefined || now < was) throw new CounterRegressionError(`meter ${key} ${counter}`, was, now);
    }
  }
}

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
  readonly #opsByKind = new OpIndex<OpKind>();
  readonly #opsByParent = new OpIndex<string>();
  readonly #opsByUnit = new OpIndex<string>();
  /** Subject-unit spawns, and backend spawns by subject unit and role. */
  readonly #spawnsByUnit = new OpIndex<string>();
  readonly #spawnsByJob = new OpIndex<JobId>();
  readonly #killsByInvocation = new OpIndex<InvocationId>();
  /** Insertion order is log order: an op is deleted when closed and re-inserted by its retry. */
  readonly #open = new Map<OpId, IntentRecord>();
  readonly #openByKey = new Map<OpKey, OpId>();
  readonly #units = new Map<UnitId, UnitEntry>();
  /** First pre-event value of each replaced counter record; never copies the whole fold. */
  readonly #unitBefore = new Map<UnitId, UnitState>();
  readonly #meterBefore = new Map<string, MeterTotal>();
  #existingUnits = 0;
  /** Every `dispatch` fact per unit, in log order: the latest is the record in force. */
  readonly #dispatches = new Map<UnitId, DispatchRecord[]>();
  /** M3: the seq of each unit's latest dispatch fact, and of the latest `plan-applied` recording it `unit-changed`. */
  readonly #pinSeq = new Map<UnitId, number>();
  readonly #unitChangedSeq = new Map<UnitId, number>();
  /** The spec the unit's dispatch facts name: its first pin's (a re-pin keeps it; see the `dispatch` case). */
  readonly #pinnedSpec = new Map<UnitId, SpecState>();
  readonly #meter = new Map<string, MeterTotal>();
  readonly #metered = new Set<InvocationId>();
  readonly #sessionCharges = new Map<ClaudeSessionId, SessionCharge>();
  readonly #needsUser = new Map<NeedsUserId, { blocking: boolean }>();
  readonly #acks = new Map<NeedsUserId, NeedsUserAckState>();
  #stop: CommandId | null = null;
  #pausedAll = false;
  readonly #pausedUnits = new Set<UnitId>();
  #containmentMode: ContainmentMode | null = null;
  #planApplied: PlanAppliedFact | null = null;
  readonly #plannedUnits = new Set<UnitId>();
  readonly #appliedBy = new Map<CommandId, PlanAppliedFact>();
  readonly #queuedApplies = new Map<CommandId, ApplyQueued>();
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
  /** Per-finding states in transition order; the last entry is the current state. */
  readonly #findings = new Map<FindingId, [FindingAt, ...FindingAt[]]>();
  readonly #audits: { started: AuditInputs & Seq; ended: AuditState['ended'] }[] = [];
  readonly #auditRequests: (Omit<FactOf<'audit-requested'>, 'kind'> & Seq)[] = [];
  readonly #docsCovered: (Omit<FactOf<'docs-covered'>, 'kind'> & Seq)[] = [];
  readonly #docsPublished: (Omit<FactOf<'docs-published'>, 'kind'> & Seq)[] = [];
  readonly #checkpoints = new Map<JobId, { inputs: CheckpointState['inputs']; decided: CheckpointState['decided'] }>();
  readonly #checkpointSkips: (Omit<FactOf<'checkpoint-skipped'>, 'kind'> & Seq)[] = [];
  readonly #divergences: (Omit<FactOf<'divergence'>, 'kind'> & Seq)[] = [];
  readonly #digests: (Omit<FactOf<'divergence-digest'>, 'kind'> & Seq)[] = [];
  readonly #steered: (Omit<FactOf<'steered'>, 'kind'> & Seq)[] = [];
  readonly #mergedIn: (Omit<FactOf<'merged-in'>, 'kind'> & Seq)[] = [];
  readonly #debt: BankedDebt[] = [];
  readonly #amendments: AmendmentState[] = [];
  readonly #packReviews: { started: PackReviewState['started']; ended: PackReviewState['ended'] }[] = [];
  // M4b
  readonly #flowFacts: FlowFactAt[] = [];
  readonly #walkFacts: WalkFactAt[] = [];
  /** Open walks and their recorded proposals, in log order. */
  readonly #openWalks = new Map<JobId, PolishId[]>();
  // dev.17
  readonly #flakes: FlakeAt[] = [];
  readonly #propagationFacts: PropagationFactAt[] = [];
  /** dev.13: per milestone, the seq of the latest `plan-applied` whose milestones change lists it in `rewalk`. */
  readonly #rewalkSeqs = new Map<MilestoneId, number>();
  #draining: Readonly<{ command: CommandId; seq: number }> | null = null;
  #completion: (Omit<FactOf<'arc-completed'>, 'kind'> & Seq) | null = null;
  // M4a rev 3
  #executorStarted = 0;
  readonly #laneReuses: LaneReuseState[] = [];
  readonly #certificates: CertificateState[] = [];
  readonly #smokeRuns: SmokeRunState[] = [];
  readonly #corroborations: CorroborationState[] = [];
  // dev.17 proportional review (`review()`)
  readonly #ledger = new Map<ReviewFindingId, FindingsLedgerEntry>();
  readonly #ledgered = new Map<string, readonly Readonly<{ index: number; id: ReviewFindingId }>[]>();
  readonly #approvals = new Map<UnitId, ReviewApproval>();
  readonly #greenLanes = new Map<UnitId, number>();
  readonly #docsOnly: (DocsOnlyFact & Seq)[] = [];

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
    this.#unitBefore.clear();
    this.#meterBefore.clear();
    this.#existingUnits = this.#units.size;
    const lastSeq = this.#lastSeq;
    const snapshotHighWater = this.#snapshotHighWater;
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
    // Preserve the original unit-table order when a bulk event changes several units.
    const units = this.#unitBefore.size > 1
      ? new Map([...this.#unitBefore].sort(([a], [b]) => this.#units.get(a)!.order - this.#units.get(b)!.order))
      : this.#unitBefore;
    monotonicSince(
      { lastSeq, snapshotHighWater, units, meter: this.#meterBefore },
      { lastSeq: this.#lastSeq, snapshotHighWater: this.#snapshotHighWater,
        units: new Map([...units.keys()].map((unit) => [unit, this.#units.get(unit)!.state])), meter: this.#meter },
    );
  }

  #intent(r: IntentRecord, fail: (detail: string) => never): void {
    const entry = this.#ops.get(r.op);
    const parentKey = canonicalJson(r.parent);
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
      if (parentKey !== entry.parentKey) fail(`retry of ${r.op} changes its parent`);
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

    const indexed = entry ?? { latest: r, closure: null, seq: this.#lastSeq + 1, parentKey };
    // Retry bodies may change a spawn's subject; remove its old memberships before replacing latest.
    if (entry?.latest.kind === 'proc.spawn') {
      const s = entry.latest.expect.subject;
      if ('unit' in s && s.unit !== null) this.#spawnsByUnit.delete(s.unit, r.op);
      if ('job' in s) this.#spawnsByJob.delete(s.job, r.op);
      if (s.purpose === 'backend') this.#spawnsByUnit.delete(`${s.unit} ${s.role}`, r.op);
    }
    if (entry?.latest.kind === 'proc.kill') this.#killsByInvocation.delete(entry.latest.expect.inv, r.op);
    indexed.latest = r;
    indexed.closure = null;
    this.#ops.set(r.op, indexed);
    this.#opsByKind.set(r.kind, indexed);
    this.#opsByParent.set(`${r.kind} ${parentKey}`, indexed);
    if (r.parent.type === 'stage') this.#opsByUnit.set(`${r.kind} ${r.parent.unit}`, indexed);
    if (r.kind === 'proc.spawn') {
      const s = r.expect.subject;
      if ('unit' in s && s.unit !== null) this.#spawnsByUnit.set(s.unit, indexed);
      if ('job' in s) this.#spawnsByJob.set(s.job, indexed);
      if (s.purpose === 'backend') this.#spawnsByUnit.set(`${s.unit} ${s.role}`, indexed);
    }
    if (r.kind === 'proc.kill') this.#killsByInvocation.set(r.expect.inv, indexed);
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
      this.#setUnitState(u, { ...u.state, stage });
      this.#start(u, `${stage}#${attempt}`);
    }
  }

  #unit(unit: UnitId, stage: Stage): UnitEntry {
    const existing = this.#units.get(unit);
    if (existing !== undefined) return existing;
    const u: UnitEntry = {
      order: this.#units.size,
      starts: new Map<string, number>(), outcomes: new Set<string>(), latestStart: null, state: this.#fresh(unit, stage), attemptBase: 0,
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
    if (!u.starts.has(start)) {
      const seq = this.#lastSeq + 1;
      u.starts.set(start, seq);
      const at = start.lastIndexOf('#');
      const attempt = Number(start.slice(at + 1));
      if (u.latestStart === null || attempt > u.latestStart.attempt) u.latestStart = { stage: start.slice(0, at) as Stage, attempt, seq };
    }
    this.#setUnitState(u, { ...u.state, counters: { ...u.state.counters, attempts: u.attemptBase + u.starts.size }, open: openStart(u) });
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
          this.#setUnitState(u, { ...u.state, status: 'retired' });
        }
      }
    }
    if (intent.kind === 'snapshot.publish') this.#snapshotHighWater = Math.max(this.#snapshotHighWater, intent.expect.highWater);
    if (intent.kind === 'spec.patch' && intent.parent.type === 'stage') {
      const u = this.#unit(intent.parent.unit, intent.parent.stage);
      this.#setUnitState(u, { ...u.state, spec: { rev: intent.post.newRev, sha256: intent.post.newSha256 } });
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
          if (f.session !== undefined && f.delegated !== undefined) {
            this.#sessionCharges.set(f.session, addCharged(this.#sessionCharges.get(f.session) ?? null, { tokens: f.usage, delegated: f.delegated }));
          }
          this.#setMeter(key, {
            ...m,
            known: m.known + 1,
            inputTokens: m.inputTokens + f.usage.inputTokens,
            outputTokens: m.outputTokens + f.usage.outputTokens,
            cacheReadTokens: m.cacheReadTokens + (f.usage.cacheReadTokens ?? 0),
            cacheWriteTokens: m.cacheWriteTokens + (f.usage.cacheWriteTokens ?? 0),
            turns: m.turns + (f.usage.turns ?? 0),
            costUsd: m.costUsd + (f.usage.costUsd ?? 0),
          });
        } else {
          this.#setMeter(key, { ...m, unavailable: m.unavailable + 1 });
        }
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
        if (u !== undefined) this.#setUnitState(u, { ...u.state, risk: riskFloor, buildTier: maxTier(riskFloor, u.state.buildTier), spec: spec ?? u.state.spec, bounds: boundsOfRecord(f.record) });
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
        if (f.unchargedLanesReds !== undefined) {
          const state = existing?.state ?? newUnitState(f.unit, f.stage, null, null, boundsOfRecord(this.dispatchOf(f.unit)));
          const steered = state.steering !== null && f.class === 'park' && (f.outcome === 'red' || f.outcome === 'not-certified');
          const charged = !steered && state.counters.unchargedLanesReds >= state.bounds.certifications - 1;
          const count = steered ? state.counters.unchargedLanesReds : charged ? 0 : state.counters.unchargedLanesReds + 1;
          const cls = steered || (charged && failures + 1 >= bound) ? 'park' : 'advance';
          if (f.chargeable !== charged || f.unchargedLanesReds !== count || f.class !== cls) fail(`stage-outcome for ${f.unit} ${key} violates its certification allowance`);
        }
        const status = existing?.state.status;
        if (status === 'cut' || status === 'superseded') fail(`stage-outcome for ${f.unit} ${key}, which is ${status}`);
        // M4a rev 3 (F4): a unit that hit a known defect prepares again (its decided outcome is lanes `known-defect`).
        const knownDefect = existing?.state.decided?.stage === 'lanes' && existing.state.decided.outcome === 'known-defect';
        if (f.stage === 'prepare' && (existing?.state.lineage ?? null) === null && !knownDefect) fail(`prepare outcome for ${f.unit}, which re-enters no unit and hit no known defect`);
        if (f.cause?.type === 'backend' && this.#backendParkSeqs.get(f.cause.parkSeq) !== f.cause.backend) {
          fail(`hold of ${f.unit} ${key} caused by backend ${f.cause.backend}'s park at seq ${f.cause.parkSeq}, which is no park of that backend`);
        }
        // Arc feedback 2026-10-15: a recovery hold closes exactly the unit's open attempt, one a crash cut short.
        const open = existing?.state.open ?? null;
        if (f.cause?.type === 'recovery' && (open === null || open.stage !== f.stage || open.attempt !== f.attempt || open.seq > this.lastExecutorStarted())) {
          fail(`recovery hold of ${f.unit} ${key}, which is not its crash-abandoned open attempt (${open === null ? 'none is open' : `${open.stage}#${open.attempt} at seq ${open.seq}`})`);
        }
        const u = this.#unit(f.unit, f.stage);
        u.outcomes.add(key);
        this.#outcomeSeqs.set(`${f.unit}/${key}`, at.seq);
        if (f.stage === 'lanes' && f.outcome === 'green') this.#greenLanes.set(f.unit, f.attempt);
        // M3: an entry's stage records its outcome (a hold keeps the entry, whose stage then runs again); a steer pass
        // ends where it parks, stops or retires the unit, or where its gate advances it.
        const entry = u.state.entry;
        if (entry !== null && f.class !== 'hold' && f.stage !== ENTRY_STAGE[entry.kind]) fail(`stage-outcome for ${f.unit} ${key} while its ${entry.kind} entry is at ${ENTRY_STAGE[entry.kind]}`);
        if (f.class !== 'hold') {
          const ends = f.class === 'park' || f.class === 'stop' || f.class === 'retire' || (f.stage === 'gate' && f.class === 'advance');
          this.#setUnitState(u, { ...u.state, entry: null, steering: ends ? null : u.state.steering });
        }
        this.#setUnitState(u, afterStageOutcome(u.state, f));
        // A recovery hold continues nothing (its attempt made no call to continue): the re-run starts from the decision and
        // the interruption before it, as the abandoned attempt's own re-run would have. It holds the unit only while a pause
        // covers it; otherwise the unit stays active and its stage runs again once admitted.
        if (f.cause?.type === 'recovery') {
          if (!this.#pausedAll && !this.#pausedUnits.has(f.unit)) this.#setUnitState(u, { ...u.state, status: 'active' });
        } else if (f.class === 'hold') this.#setUnitState(u, { ...u.state, interrupted: f });
        else {
          u.beforeDecided = { decided: u.state.decided, interrupted: u.state.interrupted };
          this.#setUnitState(u, { ...u.state, decided: f, interrupted: null, pressureHold: null });
        }
        // M4b rev 3 (RC-11): a host-pressure hold waits on admission (ready.ts), not on a resume.
        if (f.cause?.type === 'host-pressure') {
          this.#setUnitState(u, { ...u.state, status: 'active', pressureHold: { inv: f.cause.inv, at: at.at }, pressureHolds: u.state.pressureHolds + 1 });
        }
        const park = f.class === 'park' ? f.park ?? unclassedParkRecord(f) : null;
        if (park !== null) {
          this.#setUnitState(u, { ...u.state, park: { seq: at.seq, at: at.at, park, passed: [] } });
          this.#unitParkSeqs.set(at.seq, f.unit);
        }
        if (f.class === 'park' || f.class === 'stop' || f.chargeable) {
          this.#setUnitState(u, { ...u.state, failures: [...u.state.failures, { seq: at.seq, fact: f, park }] });
        }
        const lineage = u.state.lineage;
        if (f.stage === 'prepare' && f.class !== 'park' && f.class !== 'hold' && lineage !== null) this.#setUnitState(u, { ...u.state, lineage: { ...lineage, prepared: true } });
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
        this.#setUnitState(u, { ...u.state, buildTier: f.to });
        return;
      }
      case 'approval': {
        const u = this.#unit(f.unit, 'gate');
        this.#setUnitState(u, { ...u.state, approval: { attempt: f.attempt, fingerprint: f.fingerprint } });
        this.#approvals.set(f.unit, { seq: at.seq, attempt: f.attempt, fingerprint: f.fingerprint, blobs: f.blobs ?? null });
        return;
      }
      // dev.17 proportional review: minted ids follow on, one ledger fact per gate attempt, and only an open entry of the unit settles.
      case 'review-ledger': {
        const key = `${f.unit} gate#${f.attempt}`;
        if (this.#ledgered.has(key)) fail(`a second review-ledger for ${key}`);
        for (const s of f.settled) {
          const e = this.#ledger.get(s.id);
          if (e === undefined || e.unit !== f.unit) fail(`review-ledger ${key} settles ${s.id}, which is no ledger finding of ${f.unit}`);
          else if (e.outcome !== null) fail(`review-ledger ${key} settles ${s.id}, already ${e.outcome}`);
          else this.#ledger.set(s.id, { ...e, outcome: s.outcome });
        }
        for (const m of f.minted) {
          const next = reviewFindingIdOf(this.#ledger.size + 1);
          if (m.entry.id !== next) fail(`review-ledger ${key} mints ${m.entry.id}; the next ledger id is ${next}`);
          this.#ledger.set(m.entry.id, m.entry);
        }
        this.#ledgered.set(key, f.minted.map((m) => ({ index: m.index, id: m.entry.id })));
        return;
      }
      case 'docs-only':
        this.#docsOnly.push({ ...f, seq: at.seq });
        return;
      case 'docs-only-miss':
        return;
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
      case 'apply-queued':
        if (this.#queuedApplies.has(f.command)) fail(`a second apply-queued of command ${f.command}`);
        this.#queuedApplies.set(f.command, { seq: at.seq, waitsFor: f.waitsFor });
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
        this.#executorStarted = at.seq;
        return;
      case 'resumed':
        this.#resumed(f.target, fail);
        return;
      case 'scope-decided':
        this.#scopeDecided(f, fail);
        return;
      case 'reopened':
        this.#reopened(f, fail);
        this.#lastReopenSeq = at.seq;
        return;
      case 'plan-applied':
        this.#planAppliedFact(f, at.seq, fail);
        for (const c of f.changes) {
          if (c.type === 'unit-changed') this.#unitChangedSeq.set(c.unit, at.seq);
          if (c.type === 'milestones') for (const m of c.rewalk ?? []) this.#rewalkSeqs.set(m, at.seq);
        }
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
      // An earlier executor's issue facts (the issues integration was removed in 1.0.0-dev.21): read and ignored
      // (`issuesIgnored`, src/core/upgrade.ts; scaffolding).
      case 'issue-intake':
      case 'issues-captured':
        return;
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
      // M4a rev 3: lane reuse and series certificates (N1), smoke runs (N3), cross-lens corroboration (N5).
      case 'lane-reused': {
        // dev.17: one per series (parent, set, commit) and lane; a fact before dev.17 names a spec series.
        const keyOf = (r: Readonly<{ parent: unknown; lane: string; set?: string; at?: string }>): string => canonicalJson({ parent: r.parent, lane: r.lane, set: r.set ?? 'spec', at: r.at ?? null });
        const key = keyOf(f);
        if (this.#laneReuses.some((r) => keyOf(r) === key)) fail(`a second lane-reused of ${f.lane} under ${canonicalJson(f.parent)}`);
        const { op, ordinal } = parseInvocationId(f.from.inv);
        const entry = this.#ops.get(op);
        if (entry === undefined || ordinal > entry.latest.ordinal) fail(`lane-reused from ${f.from.inv}, which no intent opened`);
        const { kind: _k, ...rest } = f;
        this.#laneReuses.push({ ...rest, seq: at.seq });
        return;
      }
      case 'series-certified': {
        const key = canonicalJson({ parent: f.parent, checkout: f.checkout });
        if (this.#certificates.some((c) => canonicalJson({ parent: c.parent, checkout: c.checkout }) === key)) fail(`a second series-certified of ${f.checkout} under ${canonicalJson(f.parent)}`);
        const { kind: _k, ...rest } = f;
        this.#certificates.push({ ...rest, seq: at.seq });
        return;
      }
      case 'smoke-ran': {
        if (this.#smokeRuns.some((r) => r.unit === f.unit && r.attempt === f.attempt)) fail(`a second smoke-ran of ${f.unit} attempt ${f.attempt}`);
        const { kind: _k, ...rest } = f;
        this.#smokeRuns.push({ ...rest, seq: at.seq });
        return;
      }
      case 'needs-user-declined':
        if (!this.#needsUser.has(f.id)) fail(`needs-user-declined of ${f.id}, which was never raised`);
        if (this.#acks.has(f.id)) fail(`needs-user ${f.id} declined after it was closed`);
        this.#acks.set(f.id, { command: null, choice: f.choice });
        return;
      case 'finding-corroborated': {
        if (!this.#findings.has(f.id)) fail(`finding-corroborated of ${f.id}, which was never opened`);
        const { kind: _k, ...rest } = f;
        this.#corroborations.push({ ...rest, seq: at.seq });
        return;
      }
      // M4b (SCHEMAS.md "M4b"): the fold sees the jobs the flow facts name and keeps every flow fact (`flowFacts`); a
      // decision names a surviving proposal once, and only an accepted one is applied, once.
      case 'flow-started':
        this.#openJob(f.job, fail);
        this.#flowFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      case 'flow-ended':
      case 'flow-proof':
        this.#seeJob(f.job);
        this.#flowFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      case 'flow-decided': {
        const proposed = this.#flowFacts.some((x) => x.fact.kind === 'flow-ended' && x.fact.proposal?.id === f.proposal);
        if (!proposed) fail(`flow-decided of ${f.proposal}, which no flow-ended proposed`);
        if (this.#flowFacts.some((x) => x.fact.kind === 'flow-decided' && x.fact.proposal === f.proposal)) fail(`a second flow-decided of ${f.proposal}`);
        this.#flowFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      }
      case 'flow-applied': {
        const accepted = this.#flowFacts.some((x) => x.fact.kind === 'flow-decided' && x.fact.proposal === f.proposal && x.fact.decision === 'accepted');
        if (!accepted) fail(`flow-applied of ${f.proposal}, which was never accepted`);
        if (this.#flowFacts.some((x) => x.fact.kind === 'flow-applied' && x.fact.proposal === f.proposal)) fail(`a second flow-applied of ${f.proposal}`);
        this.#flowFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      }
      case 'flow-series':
      case 'flow-requested':
      case 'flow-verdict':
        this.#flowFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      // dev.13 (SCHEMAS.md "dev.13"): the fold sees the walk jobs and keeps every walk fact (`walkFacts`), holding a walk to
      // one start and one end, its proposals to id order and to its open walk, and a milestone pass and a tweak judgment to
      // once each. What they mean for units and milestones is read from `walkFacts` (agents C, D and G).
      case 'walk-started':
        this.#openJob(f.job, fail);
        this.#openWalks.set(f.job, []);
        this.#walkFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      case 'polish-proposed': {
        if (f.id !== this.nextPolishId()) fail(`polish-proposed ${f.id}; the next polish id is ${this.nextPolishId()}`);
        if (!this.#walkOpen(f.job)) fail(`polish-proposed ${f.id} of ${f.job}, which is not a started, unended walk`);
        this.#openWalks.get(f.job)!.push(f.id);
        this.#walkFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      }
      case 'walk-ended': {
        if (!this.#walkOpen(f.job)) fail(`walk-ended of ${f.job}, which is not a started, unended walk`);
        const proposed = this.#openWalks.get(f.job)!;
        if (proposed.join(',') !== f.proposals.join(',')) fail(`walk-ended of ${f.job} names proposals ${f.proposals.join(', ')}; it proposed ${proposed.join(', ')}`);
        this.#openWalks.delete(f.job);
        this.#walkFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      }
      case 'milestone-passed':
        if (this.#walkFacts.some((x) => x.fact.kind === 'milestone-passed' && x.fact.milestone === f.milestone)) fail(`a second milestone-passed of ${f.milestone}`);
        if (!this.#walkFacts.some((x) => x.fact.kind === 'walk-ended' && x.fact.job === f.job)) fail(`milestone-passed by ${f.job}, which has not ended`);
        this.#walkFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      case 'tweak-judged':
        if (this.#walkFacts.some((x) => x.fact.kind === 'tweak-judged' && x.fact.unit === f.unit)) fail(`a second tweak-judged of ${f.unit}`);
        this.#walkFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      // Agent D: a refusal names a recorded proposal, once; a compare opens its job, one open at a time, on a unit not yet
      // judged; `compare-abandoned` closes an open compare (a `tweak-judged` of its unit closes it too).
      case 'polish-refused':
        if (!this.#walkFacts.some((x) => x.fact.kind === 'polish-proposed' && x.fact.id === f.proposal)) fail(`polish-refused of ${f.proposal}, which no walk proposed`);
        if (this.#walkFacts.some((x) => x.fact.kind === 'polish-refused' && x.fact.proposal === f.proposal)) fail(`a second polish-refused of ${f.proposal}`);
        this.#walkFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      case 'compare-started': {
        const open = this.#openCompare();
        if (open !== null) fail(`compare-started ${f.job} while ${open} is open`);
        if (this.#walkFacts.some((x) => x.fact.kind === 'tweak-judged' && x.fact.unit === f.unit)) fail(`compare-started ${f.job} of ${f.unit}, already judged`);
        this.#openJob(f.job, fail);
        this.#walkFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      }
      case 'compare-abandoned':
        if (this.#openCompare() !== f.job) fail(`compare-abandoned of ${f.job}, which is not the open compare`);
        this.#walkFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      case 'demo-promoted':
      case 'demo-failed':
      case 'demo-acted':
        this.#walkFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      case 'flake-observed': {
        // dev.17: one per red run (its diagnostic rerun the green); the red and the green are runs this log opened.
        if (this.#flakes.some((x) => x.fact.event.red === f.event.red)) fail(`a second flake-observed of red run ${f.event.red}`);
        for (const inv of [f.event.red, f.event.green]) {
          const { op, ordinal } = parseInvocationId(inv);
          const entry = this.#ops.get(op);
          if (entry === undefined || ordinal > entry.latest.ordinal) fail(`flake-observed names ${inv}, which no intent opened`);
        }
        this.#flakes.push({ seq: at.seq, at: at.at, fact: f });
        return;
      }
      // dev.17 (SCHEMAS.md "dev.17: propagation"): the fold keeps every propagation fact (`propagationFacts`), a stale set
      // once per plan rev and a refusal once per (rev, target); a stale re-open sends its unit back to plan-check. What the
      // facts mean for units is read from `propagationFacts` (src/holistic/propagation.ts).
      case 'stale-set':
        if (this.#propagationFacts.some((x) => x.fact.kind === 'stale-set' && x.fact.rev === f.rev)) fail(`a second stale-set of plan rev ${f.rev}`);
        if (this.#planApplied?.rev !== f.rev) fail(`stale-set of plan rev ${f.rev}, which is not the plan in force (rev ${this.#planApplied?.rev ?? 'none'})`);
        for (const l of f.links) {
          const u = 'unit' in l ? this.#units.get(l.unit) : undefined;
          if (u !== undefined) this.#setUnitState(u, { ...u.state, staleRev: f.rev });
        }
        this.#propagationFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      case 'stale-answered': {
        const u = this.#units.get(f.unit);
        if (u === undefined) return fail(`stale-answered of unit ${f.unit}, which never started`);
        if (this.#propagationFacts.some((x) => x.fact.kind === 'stale-answered' && x.fact.unit === f.unit && x.fact.attempt === f.attempt)) {
          fail(`a second stale-answered of unit ${f.unit}'s plan-check attempt ${f.attempt}`);
        }
        if (u.state.staleRev !== null && u.state.staleRev <= f.rev) this.#setUnitState(u, { ...u.state, staleRev: null });
        this.#propagationFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      }
      case 'propagation-refused':
        if (this.#propagationFacts.some((x) => x.fact.kind === 'propagation-refused' && x.fact.rev === f.rev && causeKey(x.fact.target) === causeKey(f.target))) {
          fail(`a second propagation-refused of ${causeKey(f.target)} (stale set of rev ${f.rev})`);
        }
        this.#propagationFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      case 'stale-reopened':
        this.#staleReopened(f, fail);
        this.#lastReopenSeq = at.seq;
        this.#propagationFacts.push({ seq: at.seq, at: at.at, fact: f });
        return;
      default:
        this.#holisticFact(f, fail, at);
    }
  }

  #seeJob(job: JobId): void {
    const { kind, n } = parseJobId(job);
    if (n > (this.#jobs.get(kind) ?? 0)) this.#jobs.set(kind, n);
  }

  /** The compare job started and not yet closed (by its unit's `tweak-judged` or its `compare-abandoned`), or null. */
  #openCompare(): JobId | null {
    const facts = this.#walkFacts.map((x) => x.fact);
    for (const x of facts) {
      if (x.kind !== 'compare-started') continue;
      const closed = facts.some((y) => (y.kind === 'compare-abandoned' && y.job === x.job) || (y.kind === 'tweak-judged' && y.unit === x.unit));
      if (!closed) return x.job;
    }
    return null;
  }

  /** A walk job started and not yet ended. */
  #walkOpen(job: JobId): boolean {
    return this.#openWalks.has(job);
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
        for (const history of this.#findings.values()) {
          const x = history.at(-1)!.finding;
          if (x.key === f.key && FINDING_MOVES[x.state].length > 0) fail(`finding ${f.id} has the key of ${x.id}, which is ${x.state}: it merges into it`);
        }
        if (f.source.type === 'job') this.#seeJob(f.source.job);
        const { kind: _k, ...rest } = f;
        this.#findings.set(f.id, [{ seq, finding: { ...rest, state: 'open', owner: null, openedSeq: seq, last: null } }]);
        return;
      }
      case 'finding-transition': {
        const history = this.#findings.get(f.id);
        if (history === undefined) return fail(`finding-transition of ${f.id}, which was never opened`);
        const x = history.at(-1)!.finding;
        if (!FINDING_MOVES[x.state].includes(f.to.state)) fail(`finding ${f.id} moves ${x.state} → ${f.to.state}`);
        const owner = f.to.state === 'owned' || f.to.state === 'fixed-on-branch' ? f.to.unit : f.to.state === 'open' ? null : x.owner;
        history.push({ seq, finding: { ...x, state: f.to.state, owner, last: f.to } });
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
      case 'checkpoint-skipped': {
        const t = checkpointSkipTriggerOf(f);
        if (t.type === 'audit') {
          const a = this.#audits.find((x) => x.started.job === t.job);
          if (a?.ended?.outcome !== 'completed') return fail(`checkpoint-skipped of ${t.job}, which is no completed audit`);
          if (a.started.generation !== f.generation) fail(`checkpoint-skipped of ${t.job} at generation ${f.generation}; the audit's is ${a.started.generation}`);
        }
        const trigger = canonicalJson(t);
        if (this.#checkpointSkips.some((s) => canonicalJson(checkpointSkipTriggerOf(s)) === trigger)) fail(`a second checkpoint-skipped of ${trigger}`);
        const jobs = [...this.#checkpoints.values()].filter((c) => canonicalJson(c.inputs.trigger) === trigger);
        if (jobs.some((c) => c.decided !== null && c.decided.kind !== 'rejected')) fail(`checkpoint-skipped of ${trigger}, whose checkpoint decided`);
        // A pre-upgrade capture can resume at an equal decided snapshot. The skip settles it with no paid call.
        for (const c of jobs) {
          if (c.decided !== null) continue;
          if (c.inputs.generation !== f.generation) fail(`checkpoint-skipped of ${trigger} at another generation than its capture`);
          c.decided = { kind: 'no-op' };
        }
        const { kind: _k, ...rest } = f;
        this.#checkpointSkips.push({ ...rest, seq });
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
    // M4b (R5): the arc's role set is fixed at revision 1; every later revision carries it unchanged.
    const roles = this.#planApplied?.routingProvenance.arcRoles;
    if (this.#planApplied !== null && roles !== f.routingProvenance.arcRoles) fail(`plan-applied rev ${f.rev} records arcRoles ${f.routingProvenance.arcRoles ?? 'none'}; revision 1 fixed ${roles ?? 'none'}`);
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
      this.#setUnitState(entry, e.update(entry.state));
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
        order: this.#units.size,
        starts: new Map<string, number>(), outcomes: new Set<string>(), latestStart: null, attemptBase: o.counters.attempts, beforeDecided: { decided: null, interrupted: null },
        state: { ...fresh, counters, lineage: { reenters: c.reenters, root: o.lineage?.root ?? c.reenters, prepared: false } },
      });
      this.#setUnitState(old, { ...o, status: 'superseded', supersededBy: c.unit, park: null });
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
    this.#setUnitState(u, {
      ...s, status: 'active', park: null, interrupted: null, pressureHold: null, approval: null,
      entry: { kind: 'steer', seq, command: f.command, brief: f.brief, budgetMin: f.budgetMin, resume: f.resume }, steering: { seq, resume: f.resume },
    });
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
    this.#setUnitState(u, {
      ...s, status: s.status === 'park-pending' ? 'active' : s.status, park: null, interrupted: null, pressureHold: null, approval: null,
      entry: { kind: 'merge-in', seq, command: f.command }, steering: null,
    });
  }

  /** The unit re-runs the stage its park decided at: decision and interruption as before the park. */
  #restoreParked(u: UnitEntry, recovery: UnitState['lastRecovery']): void {
    const decided = u.state.decided;
    if (decided === null) throw new Error(`restore of unit ${u.state.unit}, which decided nothing`);
    this.#setUnitState(u, { ...u.state, stage: decided.stage, status: 'active', ...u.beforeDecided, park: null, lastRecovery: recovery ?? u.state.lastRecovery });
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
    for (const [u, park] of passed) this.#setUnitState(u, { ...u.state, park });
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
      if (cause?.type === 'backend' && cause.backend === backend && cause.parkSeq <= seq) this.#setUnitState(u, { ...u.state, status: 'active' });
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
    this.#setUnitState(u, {
      ...u.state, stage: 'plan-check', status: 'active', decided: null, interrupted: null, pressureHold: null, park: null, spec: { rev: f.specRev, sha256: f.specSha256 },
      reopened: { command: f.command, specRev: f.specRev }, redirectBase: u.state.counters.redirects, pendingRevision: null,
    });
  }

  /**
   * dev.17 (propagation): an in-flight unit with unanswered stale links re-opens at plan-check on its spec in force (no spec
   * change): as `reopened` does, its decision and interruption cleared, its counters kept, the redirect bound counted from here,
   * and its next fresh build resuming its implementer session (`reopened`, with no command).
   */
  #staleReopened(f: Extract<Fact, { kind: 'stale-reopened' }>, fail: (detail: string) => never): void {
    const u = this.#units.get(f.unit);
    if (u === undefined) return fail(`stale-reopened of unit ${f.unit}, which never started`);
    if (u.state.status !== 'active') fail(`stale-reopened of unit ${f.unit}, which is ${u.state.status}`);
    if (u.state.pendingRevision !== null) fail(`stale-reopened of unit ${f.unit}, which has a pending revision (it re-opens on that)`);
    if (u.state.staleRev !== f.rev) fail(`stale-reopened of unit ${f.unit} on the stale set of rev ${f.rev}; its unanswered one is ${u.state.staleRev ?? 'none'}`);
    const spec = u.state.spec;
    if (spec === null) return fail(`stale-reopened of unit ${f.unit}, which has no spec recorded`);
    this.#setUnitState(u, {
      ...u.state, stage: 'plan-check', decided: null, interrupted: null, pressureHold: null, park: null,
      reopened: { command: null, specRev: spec.rev }, redirectBase: u.state.counters.redirects,
    });
  }

  /**
   * The root agent's decision on a held scope-growth proposal (src/commands/scope.ts): only of the unit held by that
   * plan-check (or, plan defects 2026-10-16, lanes) attempt's `scope-growth` hold. It releases the hold (the stage re-runs
   * as a new, uncharged attempt, or an accepted growth re-opens the unit at plan-check) and is kept with the proposals it
   * decided.
   */
  #scopeDecided(f: Extract<Fact, { kind: 'scope-decided' }>, fail: (detail: string) => never): void {
    const u = this.#units.get(f.unit);
    if (u === undefined) return fail(`scope-decided of unit ${f.unit}, which never started`);
    const held = u.state.interrupted;
    const stage = held === null ? null : scopeHoldStage(held.stage);
    if (u.state.status !== 'held' || held === null || stage === null || held.outcome !== 'scope-growth' || held.attempt !== f.attempt || held.detail?.kind !== 'scope-growth') {
      return fail(`scope-decided of unit ${f.unit} attempt ${f.attempt}, which is not the unit's scope-growth hold (status ${u.state.status}, held ${held === null ? 'none' : `${held.stage}#${held.attempt} ${held.outcome}`})`);
    }
    const decision: ScopeDecision = { stage, attempt: f.attempt, command: f.command, decision: f.decision, proposals: held.detail.proposals, reason: f.reason };
    this.#setUnitState(u, { ...u.state, status: 'active', scopeDecisions: [...u.state.scopeDecisions, decision] });
  }

  /**
   * A resume clears holds without touching counters, so the next stage start is a new, uncharged attempt.
   * `unit`: that unit's pause and hold (refused while the whole arc is paused). `all`: every pause and every
   * hold. `backend`: that backend's current park, whatever its class, and the holds it caused (G5).
   */
  #resumed(target: Extract<Fact, { kind: 'resumed' }>['target'], fail: (detail: string) => never): void {
    const release = (u: UnitEntry): void => {
      if (u.state.status === 'held') this.#setUnitState(u, { ...u.state, status: 'active' });
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

  /** The one writer of an existing unit's immutable state, capturing its pre-event counters once. */
  #setUnitState(u: UnitEntry, state: UnitState): void {
    if (u.order < this.#existingUnits && !this.#unitBefore.has(u.state.unit)) this.#unitBefore.set(u.state.unit, u.state);
    u.state = state;
  }

  #setMeter(key: string, total: MeterTotal): void {
    const before = this.#meter.get(key);
    if (before !== undefined && !this.#meterBefore.has(key)) this.#meterBefore.set(key, before);
    this.#meter.set(key, total);
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
    return this.#opsByKind.get(kind) as readonly IntentOf<K>[];
  }

  opsOfParent<K extends OpKind>(kind: K, parent: Parent): readonly IntentOf<K>[] {
    return this.#opsByParent.get(`${kind} ${canonicalJson(parent)}`) as readonly IntentOf<K>[];
  }

  opsOfUnit<K extends OpKind>(kind: K, unit: UnitId): readonly IntentOf<K>[] {
    return this.#opsByUnit.get(`${kind} ${unit}`) as readonly IntentOf<K>[];
  }

  spawnsOfUnit(unit: UnitId, role?: UnitRole): readonly IntentOf<'proc.spawn'>[] {
    return this.#spawnsByUnit.get(role === undefined ? unit : `${unit} ${role}`) as readonly IntentOf<'proc.spawn'>[];
  }

  spawnsOfJob(job: JobId): readonly IntentOf<'proc.spawn'>[] {
    return this.#spawnsByJob.get(job) as readonly IntentOf<'proc.spawn'>[];
  }

  killsOfInvocation(inv: InvocationId): readonly IntentOf<'proc.kill'>[] {
    return this.#killsByInvocation.get(inv) as readonly IntentOf<'proc.kill'>[];
  }

  usageRecorded(inv: InvocationId): boolean {
    return this.#metered.has(inv);
  }

  sessionCharge(session: ClaudeSessionId): SessionCharge | null {
    return this.#sessionCharges.get(session) ?? null;
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

  applyQueued(command: CommandId): ApplyQueued | null {
    return this.#queuedApplies.get(command) ?? null;
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

  lastExecutorStarted(): number {
    return this.#executorStarted;
  }

  flowFacts(): readonly FlowFactAt[] {
    return this.#flowFacts;
  }

  walkFacts(): readonly WalkFactAt[] {
    return this.#walkFacts;
  }

  flakes(): readonly FlakeAt[] {
    return this.#flakes;
  }

  propagationFacts(): readonly PropagationFactAt[] {
    return this.#propagationFacts;
  }

  rewalkSeq(milestone: MilestoneId): number {
    return this.#rewalkSeqs.get(milestone) ?? 0;
  }

  nextPolishId(): PolishId {
    return polishIdOf(this.#walkFacts.filter((x) => x.fact.kind === 'polish-proposed').length + 1);
  }

  findingsAt(seq: number): readonly FindingState[] {
    const out: FindingState[] = [];
    for (const history of this.#findings.values()) {
      let low = 0;
      let high = history.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (history[middle]!.seq <= seq) low = middle + 1;
        else high = middle;
      }
      if (low > 0) out.push(history[low - 1]!.finding);
    }
    return out;
  }

  holistic(): HolisticFold {
    const c = this.#completion;
    const active = c !== null && this.#planApplied?.rev === c.planRev && (this.#head === null || this.#head === c.head) && this.#lastReopenSeq < c.seq;
    return {
      on: this.#holisticOn,
      witnessed: this.#witnessed,
      latched: [...this.#latched.values()],
      findings: [...this.#findings.values()].map((history) => history.at(-1)!.finding),
      audits: this.#audits.map((a) => ({ started: a.started, ended: a.ended })),
      auditRequests: this.#auditRequests,
      docsCovered: this.#docsCovered,
      docsPublished: this.#docsPublished,
      checkpoints: [...this.#checkpoints.values()].map((x) => ({ inputs: x.inputs, decided: x.decided })),
      checkpointSkips: [...this.#checkpointSkips],
      divergences: this.#divergences,
      digests: this.#digests,
      steered: this.#steered,
      mergedIn: this.#mergedIn,
      debt: this.#debt,
      amendments: this.#amendments,
      packReviews: this.#packReviews.map((r) => ({ started: r.started, ended: r.ended })),
      draining: this.#draining,
      completion: c === null ? null : { ...c, active },
      laneReuses: this.#laneReuses,
      certificates: this.#certificates,
      smokeRuns: this.#smokeRuns,
      corroborations: this.#corroborations,
    };
  }

  /** dev.17 proportional review: the findings ledger, the latest approval of each unit, and the docs-only checks. */
  review(): ReviewFold {
    return {
      ledger: [...this.#ledger.values()],
      nextFindingId: reviewFindingIdOf(this.#ledger.size + 1),
      ledgered: (unit, attempt) => this.#ledgered.get(`${unit} gate#${attempt}`) ?? null,
      approval: (unit) => this.#approvals.get(unit) ?? null,
      greenLanes: (unit) => this.#greenLanes.get(unit) ?? null,
      docsOnly: this.#docsOnly,
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
  const latest = u.latestStart;
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
