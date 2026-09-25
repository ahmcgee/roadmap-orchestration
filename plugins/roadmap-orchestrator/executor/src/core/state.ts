// The fold: the one derivation of run state from the event log. Everything the executor knows about ops,
// units, spend and needs-user comes from folding events.jsonl in order; `state.json` is a cache of the
// result for humans and tools, and nothing reads it back for a decision.
//
// The fold also enforces the log's invariants (SCHEMAS.md "Event log"): a violation throws
// FoldInvariantError. At open the journal turns that into a refusal (`log-corrupt`); at append it means
// the caller asked for an illegal record, and nothing is written.
import {
  type AbortRecord, type DoneRecord, type Event, type Fact, type IntentOf, type IntentRecord, type OpKind, prevHash, serializeEvent,
} from './events.ts';
import { atomicJson, monotonic } from './fsx.ts';
import {
  type ArcId, type InvocationId, type NeedsUserId, type OpId, type OpKey, type RoutingRev, type Sha256Hex,
  type UnitId, parseInvocationId, parseOpId,
} from './ids.ts';
import type { JournalView } from './interfaces.ts';
import { canonicalJson } from './json.ts';
import type { Stage } from './records.ts';
import { SCHEMA_VERSION, type SchemaVersion } from './version.ts';
import type { Role } from '../routing/types.ts';

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

/** A unit's position: the stage of its latest stage-parented intent, and how many stage starts it has seen. */
export type UnitState = Readonly<{ unit: UnitId; stage: Stage; attempts: number }>;

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
  /** Ids raised by a done `needsuser.raise`. Acknowledgement is a file beside it, not an event. */
  needsUser: readonly NeedsUserId[];
  /** Every `tail-discarded` fact, in log order. */
  tailDiscarded: readonly TailDiscarded[];
}>;

type Closure = Readonly<{ type: 'done'; record: DoneRecord }> | Readonly<{ type: 'abort'; record: AbortRecord }>;
type OpEntry = { latest: IntentRecord; closure: Closure | null };
type UnitEntry = { stage: Stage; starts: Set<string> };
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
  readonly #meter = new Map<string, MeterEntry>();
  readonly #metered = new Set<InvocationId>();
  readonly #needsUser = new Set<NeedsUserId>();
  readonly #tail: TailDiscarded[] = [];

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
      const u = this.#units.get(unit) ?? { stage, starts: new Set<string>() };
      u.stage = stage;
      u.starts.add(`${stage}#${attempt}`);
      this.#units.set(unit, u);
    }
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
    if (intent.kind === 'needsuser.raise') this.#needsUser.add(intent.expect.id);
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
      case 'containment-mode':
      case 'dispatch':
        return;
    }
  }

  /** Every counter the fold derives, flattened, for the `monotonic()` check around each event. */
  #counters(): Record<string, number> {
    const out: Record<string, number> = { lastSeq: this.#lastSeq, snapshotHighWater: this.#snapshotHighWater };
    for (const [unit, u] of this.#units) out[`unit ${unit} attempts`] = u.starts.size;
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

  derived(): DerivedState {
    return {
      v: SCHEMA_VERSION,
      arc: this.arc,
      lastSeq: this.#lastSeq,
      snapshotHighWater: this.#snapshotHighWater,
      openIntents: this.openIntents(),
      units: [...this.#units].sort(([a], [b]) => compare(a, b)).map(([unit, u]) => ({ unit, stage: u.stage, attempts: u.starts.size })),
      meter: [...this.#meter].sort(([a], [b]) => compare(a, b)).map(([, m]) => ({ ...m })),
      needsUser: [...this.#needsUser].sort(compare),
      tailDiscarded: [...this.#tail],
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
