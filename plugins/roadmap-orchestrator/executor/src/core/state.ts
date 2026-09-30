// The fold: the one derivation of run state from the event log. Everything the executor knows about ops,
// units, spend and needs-user comes from folding events.jsonl in order; `state.json` is a cache of the
// result for humans and tools, and nothing reads it back for a decision.
//
// The fold also enforces the log's invariants (SCHEMAS.md "Event log"): a violation throws
// FoldInvariantError. At open the journal turns that into a refusal (`log-corrupt`); at append it means
// the caller asked for an illegal record, and nothing is written.
import {
  type AbortRecord, type BackendParkClass, type DoneRecord, type Event, type Fact, type Holder, type IntentOf, type IntentRecord, type JudgmentInputs,
  type JudgmentStage, type OpKind, type ParkRecord, type PlanAppliedFact, type ProbeTarget, type ResourceEdge, type RetryStage, type StageOutcomeFact,
  JUDGMENT_STAGES, RECLAIM_HOLDERS, RETRY_STAGES, RETRYABLE_BACKEND_PARKS, prevHash, probeTargetKey, serializeEvent,
} from './events.ts';
import { atomicJson, monotonic } from './fsx.ts';
import {
  type ArcId, type CommandId, type EdgeId, type InvocationId, type NeedsUserId, type OpId, type OpKey, type PlanRev, type ResourceUnit,
  type RoutingRev, type Sha256Hex, type SpecRev, type UnitId, compareResourceUnits, parseInvocationId, parseOpId,
} from './ids.ts';
import type { ControlState, JournalView, NeedsUserAckState, NeedsUserState } from './interfaces.ts';
import { canonicalJson } from './json.ts';
import type { ApprovalFingerprint, ContainmentMode, DispatchRecord, Stage } from './records.ts';
import { legacyParkRecord, repinNamesSpec, rerouteAsUnpark } from './upgrade.ts';
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

/** The third chargeable (design-class) failure parks the unit. */
export const CHARGEABLE_BOUND = 3;

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
 * seq), its class as recorded (or the pre-M2 default), and the retryable targets a covering probe has passed.
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
}>;

export function newUnitState(unit: UnitId, stage: Stage, risk: RiskTier | null, spec: SpecState | null = null): UnitState {
  const retries = Object.fromEntries(RETRY_STAGES.map((s) => [s, 0])) as Record<RetryStage, number>;
  return {
    unit, stage, risk, status: 'active', routedUp: [], promotion: false, decided: null, interrupted: null, approval: null, open: null,
    counters: { attempts: 0, chargeableFailures: 0, redirects: 0, reviseRounds: 0, candidateReds: 0, retries },
    spec, reopened: null, pendingRevision: null, redirectBase: 0,
    park: null, lastRecovery: null, buildTier: risk, lineage: null, supersededBy: null,
  };
}

/** The higher of two risk tiers. */
export function maxTier(a: RiskTier, b: RiskTier | null): RiskTier {
  return b !== null && RISK_TIERS.indexOf(b) > RISK_TIERS.indexOf(a) ? b : a;
}

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

/** The latest probe of one target, with the time its fact was written. */
export type ProbeState = Extract<Fact, { kind: 'probe' }> & Readonly<{ seq: number; at: IsoTime }>;

export type EdgeResolvedState = Readonly<{ command: CommandId; evidence: string; seq: number }>;

/** How the arc schedules (M2): fixed by its first `plan-applied` fact; null before one. */
export type Scheduling = 'dag' | 'legacy';

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
  /** M2: `dag`, or `legacy` for an arc started on 1.0.0-dev.4 or earlier; null before the first plan revision. */
  scheduling: Scheduling | null;
  /** M2: every resource unit a transition named, ascending in lock order, with its state and open transition. */
  resources: readonly Readonly<{ unit: ResourceUnit; status: ResourceStatus; pending: OpId | null }>[];
  /** M2: the `run-only` allowlist in force, or null. */
  runOnly: readonly UnitId[] | null;
  /** M2: contingent edges resolved, ascending. */
  resolvedEdges: readonly EdgeId[];
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
  readonly #probes = new Map<string, ProbeState>();
  readonly #judgmentInputs = new Map<string, JudgmentInputs>();
  readonly #resolvedEdges = new Map<EdgeId, EdgeResolvedState>();
  #runOnly: readonly UnitId[] | null = null;
  #scheduling: Scheduling | null = null;
  /** Rank's seqs (F17): each stage-outcome fact's by `<unit>/<stage>#<attempt>`, each published ff's done, each unit's first naming. */
  readonly #outcomeSeqs = new Map<string, number>();
  readonly #publications: Readonly<{ unit: UnitId; seq: number }>[] = [];
  readonly #addedSeqs = new Map<UnitId, number>();

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
        this.#done(event, event.seq, fail);
        break;
      case 'abort':
        this.#abort(event, fail);
        break;
      case 'fact':
        this.#fact(event.fact, fail, { seq: event.seq, at: event.at });
        break;
    }
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

  /** A unit with no stage state yet: at `stage`, with its latest pin's risk floor and its pinned spec. */
  #fresh(unit: UnitId, stage: Stage): UnitState {
    return newUnitState(unit, stage, this.#dispatches.get(unit)?.at(-1)?.riskFloor ?? null, this.#pinnedSpec.get(unit) ?? null);
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

  #done(r: DoneRecord, seq: number, fail: (detail: string) => never): void {
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
    if (intent.kind === 'needsuser.raise') this.#needsUser.set(intent.expect.id, { blocking: intent.expect.blocking });
    // A unit's publication is its ff stage's; an ff under another parent (the git primitives' own tests) publishes no unit.
    if (intent.kind === 'integration.ff' && r.kind === 'integration.ff' && r.outcome.kind === 'published' && intent.parent.type === 'stage') {
      this.#publications.push({ unit: intent.parent.unit, seq });
    }
    if (intent.kind === 'snapshot.publish') this.#snapshotHighWater = Math.max(this.#snapshotHighWater, intent.expect.highWater);
    if (intent.kind === 'spec.patch' && intent.parent.type === 'stage') {
      const u = this.#unit(intent.parent.unit, intent.parent.stage);
      u.state = { ...u.state, spec: { rev: intent.post.newRev, sha256: intent.post.newSha256 } };
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
        const charge: MeterCharge = f.subject.type === 'seat' ? { type: 'role', role: f.subject.role } : { type: 'smoke', backend: f.subject.backend };
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
        // A re-pin (a plan-check raise) keeps the scope envelope and never lowers the risk floor (R2).
        if (prev !== undefined && canonicalJson(prev.scope) !== canonicalJson(scope)) fail(`dispatch of ${unit} changes its pinned scope`);
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
        // Only the first pin names the spec in force: a re-pin carries the spec its record was first made at
        // (an arc 1.0.0-dev.3 started took each re-pin's, until its first plan revision: src/core/upgrade.ts).
        const spec = prev === undefined || repinNamesSpec(this.#planApplied !== null) ? specOf(f.record) : null;
        if (spec !== null) this.#pinnedSpec.set(unit, spec);
        if (u !== undefined) u.state = { ...u.state, risk: riskFloor, buildTier: maxTier(riskFloor, u.state.buildTier), spec: spec ?? u.state.spec };
        return;
      }
      case 'stage-outcome': {
        const key = `${f.stage}#${f.attempt}`;
        const existing = this.#units.get(f.unit);
        if (existing?.outcomes.has(key) === true) fail(`second stage-outcome for ${f.unit} ${key}`);
        const failures = existing?.state.counters.chargeableFailures ?? 0;
        if (f.chargeable && failures === CHARGEABLE_BOUND - 1 && f.class !== 'park') {
          fail(`stage-outcome for ${f.unit} ${key} is chargeable failure ${CHARGEABLE_BOUND}, which parks the unit, but its class is ${f.class}`);
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
        u.state = afterStageOutcome(u.state, f);
        if (f.class === 'hold') u.state = { ...u.state, interrupted: f };
        else {
          u.beforeDecided = { decided: u.state.decided, interrupted: u.state.interrupted };
          u.state = { ...u.state, decided: f, interrupted: null };
        }
        if (f.class === 'park') {
          u.state = { ...u.state, park: { seq: at.seq, at: at.at, park: f.park ?? legacyParkRecord(f), passed: [] } };
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
        if (this.#judgmentInputs.has(key)) fail(`second judgment-inputs for ${key}`);
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
        if (state.counters.chargeableFailures >= CHARGEABLE_BOUND) fail(`implementer-escalated for ${f.unit} at the chargeable bound`);
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
        return;
      case 'rerouted':
        this.#rerouted(f, fail);
        return;
      case 'plan-applied':
        this.#planAppliedFact(f, at.seq, fail);
        return;
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
    // M2 schedules a DAG only from a log no earlier release dispatched in (the reader admits `scheduling` on rev 1 only).
    if (f.scheduling === 'dag' && this.#dispatches.size > 0) fail('plan-applied rev 1 schedules a DAG in a log that already dispatched a unit');
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
    if (f.rev === 1) this.#scheduling = f.scheduling === 'dag' ? 'dag' : 'legacy';
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
   * A reroute: only of a unit parked `routing-changed` (the command re-pinned it under the routing in force
   * first, when that routing's rev differs from the pinned one). Read as an `unparked` fact (M2), which
   * re-runs the parked stage the same way.
   */
  #rerouted(f: Extract<Fact, { kind: 'rerouted' }>, fail: (detail: string) => never): void {
    const decided = this.#units.get(f.unit)?.state.decided ?? null;
    if (decided === null || decided.outcome !== 'routing-changed') return fail(`reroute of unit ${f.unit}, which is not parked routing-changed`);
    rerouteAsUnpark(f.unit);
    this.#unpark(f.unit, fail);
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
      this.#releaseBackendHolds(backend, seq, false);
    }
  }

  /**
   * Releases the holds `backend`'s parks caused (G5): a hold whose cause is that backend at a park seq up to
   * `seq`. Operator pauses are kept. `legacy`: also every cause-less hold of a unit no pause covers, as
   * `resume --backend` released usage-limit holds before M2 recorded a cause.
   */
  #releaseBackendHolds(backend: Backend, seq: number, legacy: boolean): void {
    if (this.#pausedAll) return;
    for (const [id, u] of this.#units) {
      if (u.state.status !== 'held' || this.#pausedUnits.has(id)) continue;
      const cause = u.state.interrupted?.cause;
      if (cause === undefined ? legacy : cause.backend === backend && cause.parkSeq <= seq) u.state = { ...u.state, status: 'active' };
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
   * hold. `backend`: that backend's current park, whatever its class, and the holds it caused (G5) plus the
   * cause-less holds of units no pause covers (a usage-limit hold recorded before M2).
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
        this.#releaseBackendHolds(target.backend, park.seq, true);
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

  unitsWithState(): readonly UnitId[] {
    return [...new Set([...this.#units.keys(), ...this.#dispatches.keys()])].sort(compare);
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

  scheduling(): Scheduling | null {
    return this.#scheduling;
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
      scheduling: this.#scheduling,
      resources: [...this.#resources].sort(([a], [b]) => compareResourceUnits(a, b)).map(([unit, e]) => ({ unit, status: e.status, pending: e.pending?.op ?? null })),
      runOnly: this.#runOnly,
      resolvedEdges: [...this.#resolvedEdges.keys()].sort(compare),
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
