// The fold: the one derivation of run state from the event log. Everything the executor knows about ops,
// units, spend and needs-user comes from folding events.jsonl in order; `state.json` is a cache of the
// result for humans and tools, and nothing reads it back for a decision.
//
// The fold also enforces the log's invariants (SCHEMAS.md "Event log"): a violation throws
// FoldInvariantError. At open the journal turns that into a refusal (`log-corrupt`); at append it means
// the caller asked for an illegal record, and nothing is written.
import {
  type AbortRecord, type DoneRecord, type Event, type Fact, type IntentOf, type IntentRecord, type JudgmentStage, type OpKind,
  type RetryStage, type StageOutcomeFact, JUDGMENT_STAGES, RETRY_STAGES, prevHash, serializeEvent,
} from './events.ts';
import { atomicJson, monotonic } from './fsx.ts';
import {
  type ArcId, type CommandId, type InvocationId, type NeedsUserId, type OpId, type OpKey, type RoutingRev, type Sha256Hex,
  type UnitId, parseInvocationId, parseOpId,
} from './ids.ts';
import type { ControlState, JournalView, NeedsUserAckState, NeedsUserState } from './interfaces.ts';
import { canonicalJson } from './json.ts';
import type { ApprovalFingerprint, ContainmentMode, DispatchRecord, Stage } from './records.ts';
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
 * `held` means the stage was interrupted and waits for a resume.
 */
export type UnitStatus = 'active' | 'held' | 'park-pending' | 'stop-pending' | 'retired';

/** A unit's position and everything the transition table reads, derived from the log alone. */
export type UnitState = Readonly<{
  unit: UnitId;
  /** The stage of its latest stage-parented intent or stage-outcome fact. */
  stage: Stage;
  /** The riskFloor of the unit's latest dispatch fact (a plan-check raise re-pins it); null before one. */
  risk: RiskTier | null;
  status: UnitStatus;
  counters: UnitCounters;
  /** Judgment stages routed up to their role's high seat; they stay there for the rest of the unit. */
  routedUp: readonly JudgmentStage[];
  /** A risk trigger is pending: the next judgment dispatch sits on the high seat. */
  promotion: boolean;
  /**
   * The latest stage-outcome fact that decided the unit's next step: every class but `hold` (a held stage
   * re-runs what this outcome decided). The unit driver derives its next stage and that stage's inputs from
   * it; null before the first outcome.
   */
  decided: StageOutcomeFact | null;
  /** The latest gate approval: its attempt and the fingerprint it binds to; null before one. */
  approval: Readonly<{ attempt: number; fingerprint: ApprovalFingerprint }> | null;
}>;

export function newUnitState(unit: UnitId, stage: Stage, risk: RiskTier | null): UnitState {
  const retries = Object.fromEntries(RETRY_STAGES.map((s) => [s, 0])) as Record<RetryStage, number>;
  return {
    unit, stage, risk, status: 'active', routedUp: [], promotion: false, decided: null, approval: null,
    counters: { attempts: 0, chargeableFailures: 0, redirects: 0, reviseRounds: 0, candidateReds: 0, retries },
  };
}

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

/** Spend per seat: `known` invocations with token usage, `unavailable` ones without. Never a model id. */
export type MeterTotal = Readonly<{
  role: Role;
  routingRev: RoutingRev;
  known: number;
  unavailable: number;
  inputTokens: number;
  outputTokens: number;
  /** Sums of the reported figures; a backend that reports null for a figure contributes nothing. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
}>;

/** The fold's result, and the content of the `state.json` cache. Sets are sorted arrays. */
export type DerivedState = Readonly<{
  v: SchemaVersion;
  arc: ArcId;
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
  /** Backends parked arc-wide by a `backend-park` fact (usage limit or capacity), ascending. */
  parkedBackends: readonly Backend[];
}>;

type Closure = Readonly<{ type: 'done'; record: DoneRecord }> | Readonly<{ type: 'abort'; record: AbortRecord }>;
type OpEntry = { latest: IntentRecord; closure: Closure | null };
/** `starts` and `outcomes` hold `<stage>#<attempt>`; `state.counters.attempts` is `starts.size`. */
type UnitEntry = { starts: Set<string>; outcomes: Set<string>; state: UnitState };
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
  readonly #dispatch = new Map<UnitId, DispatchRecord>();
  readonly #meter = new Map<string, MeterEntry>();
  readonly #metered = new Set<InvocationId>();
  readonly #needsUser = new Map<NeedsUserId, { blocking: boolean }>();
  readonly #acks = new Map<NeedsUserId, NeedsUserAckState>();
  #stop: CommandId | null = null;
  #pausedAll = false;
  readonly #pausedUnits = new Set<UnitId>();
  #containmentMode: ContainmentMode | null = null;
  readonly #tail: TailDiscarded[] = [];
  readonly #parkedBackends = new Set<Backend>();

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
        this.#done(event, fail);
        break;
      case 'abort':
        this.#abort(event, fail);
        break;
      case 'fact':
        this.#fact(event.fact, fail);
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

    this.#ops.set(r.op, { latest: r, closure: null });
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
    const u = { starts: new Set<string>(), outcomes: new Set<string>(), state: newUnitState(unit, stage, this.#dispatch.get(unit)?.riskFloor ?? null) };
    this.#units.set(unit, u);
    return u;
  }

  #start(u: UnitEntry, start: string): void {
    u.starts.add(start);
    u.state = { ...u.state, counters: { ...u.state.counters, attempts: u.starts.size } };
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

  #done(r: DoneRecord, fail: (detail: string) => never): void {
    const entry = this.#openEntry(r.op, 'done', fail);
    const intent = entry.latest;
    if (r.kind !== intent.kind) fail(`done of kind ${r.kind} for ${r.op}, an intent of kind ${intent.kind}`);
    this.#close(entry, { type: 'done', record: r });
    if (intent.kind === 'needsuser.raise') this.#needsUser.set(intent.expect.id, { blocking: intent.expect.blocking });
    if (intent.kind === 'snapshot.publish') this.#snapshotHighWater = Math.max(this.#snapshotHighWater, intent.expect.highWater);
  }

  #abort(r: AbortRecord, fail: (detail: string) => never): void {
    this.#close(this.#openEntry(r.op, 'abort', fail), { type: 'abort', record: r });
  }

  #fact(f: Fact, fail: (detail: string) => never): void {
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
        const key = `${f.role} ${f.routingRev}`;
        const m = this.#meter.get(key) ?? {
          role: f.role, routingRev: f.routingRev, known: 0, unavailable: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        };
        if (f.kind === 'meter') {
          m.known += 1;
          m.inputTokens += f.usage.inputTokens;
          m.outputTokens += f.usage.outputTokens;
          m.cacheReadTokens += f.usage.cacheReadTokens ?? 0;
          m.cacheWriteTokens += f.usage.cacheWriteTokens ?? 0;
        } else {
          m.unavailable += 1;
        }
        this.#meter.set(key, m);
        return;
      }
      case 'dispatch': {
        const { unit, scope, riskFloor } = f.record;
        const prev = this.#dispatch.get(unit);
        // A re-pin (a plan-check raise) keeps the scope envelope and never lowers the risk floor (R2).
        if (prev !== undefined && canonicalJson(prev.scope) !== canonicalJson(scope)) fail(`dispatch of ${unit} changes its pinned scope`);
        if (prev !== undefined && RISK_TIERS.indexOf(riskFloor) < RISK_TIERS.indexOf(prev.riskFloor)) {
          fail(`dispatch of ${unit} lowers riskFloor ${prev.riskFloor} to ${riskFloor}`);
        }
        this.#dispatch.set(unit, f.record);
        const u = this.#units.get(unit);
        if (u !== undefined) u.state = { ...u.state, risk: riskFloor };
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
        const u = this.#unit(f.unit, f.stage);
        u.outcomes.add(key);
        u.state = afterStageOutcome(u.state, f);
        if (f.class !== 'hold') u.state = { ...u.state, decided: f };
        this.#start(u, key);
        return;
      }
      case 'approval': {
        const u = this.#unit(f.unit, 'gate');
        u.state = { ...u.state, approval: { attempt: f.attempt, fingerprint: f.fingerprint } };
        return;
      }
      case 'backend-park':
        this.#parkedBackends.add(f.backend);
        return;
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
      case 'resumed':
        this.#resumed(f.target, fail);
        return;
    }
  }

  /**
   * A resume clears holds without touching counters, so the next stage start is a new, uncharged attempt.
   * `unit`: that unit's pause and hold (refused while the whole arc is paused). `all`: every pause and every
   * hold. `backend`: that backend's park, and the holds of units no pause covers (a usage-limit hold).
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
      case 'backend':
        if (!this.#parkedBackends.delete(target.backend)) fail(`resume of backend ${target.backend}, which is not parked`);
        if (this.#pausedAll) return;
        for (const [id, u] of this.#units) if (!this.#pausedUnits.has(id)) release(u);
        return;
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
    return this.#units.get(unit)?.state ?? newUnitState(unit, 'plan-check', this.#dispatch.get(unit)?.riskFloor ?? null);
  }

  dispatchOf(unit: UnitId): DispatchRecord | null {
    return this.#dispatch.get(unit) ?? null;
  }

  parkedBackends(): readonly Backend[] {
    return [...this.#parkedBackends].sort(compare);
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

  derived(): DerivedState {
    return {
      v: SCHEMA_VERSION,
      arc: this.arc,
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
    };
  }
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
