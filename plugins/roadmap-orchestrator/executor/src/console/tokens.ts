// The inputs of the always-current views (shell, graph, metadata's view versions) as accumulators: extended with each
// observation's appended events and changed rows, so a revision costs work in proportion to what changed. A serve model
// keeps one per arc (src/console/model.ts) and registers it for the observation data it publishes; any other envelope (a test's,
// a changed copy) gets tokens built from nothing by the same code.
import { createHash } from 'node:crypto';
import type { Event } from '../core/events.ts';
import { canonicalJson } from '../core/json.ts';
import type { ObservationData } from '../observation/protocol.ts';
import type { Invocation } from '../tui/types.ts';
import { StageIndex } from './indexes.ts';

const PARKS = new Set(['backend-park', 'resumed', 'probe', 'arc-completed', 'stop-completed']);
const MONEY = new Set(['meter', 'usage-unavailable']);
const AUDITS = new Set(['audit-started', 'audit-ended']);
const digest = (value: unknown): Buffer => createHash('sha256').update(canonicalJson(value)).digest();
const xor = (into: Buffer, d: Buffer): void => { for (let i = 0; i < 32; i++) into[i]! ^= d[i]!; };
/** What the typed views read of an invocation row (metadata.ts hashes these). */
const projection = (i: Invocation) => ({id: i.id, unit: i.unit, role: i.role, attempt: i.attempt, state: i.state, assessment: i.assessment ?? null,
  scope: i.scope ?? null, relatedUnits: i.relatedUnits ?? [], milestone: i.milestone ?? null, execution: i.execution ?? null,
  backend: i.backend ?? null, model: i.model ?? null, requestedModel: i.requestedModel ?? null,
  startedAt: i.startedAt, endedAt: i.endedAt, work: i.work ?? null});
const resourceProjection = (i: Invocation) => ({id: i.id, role: i.role, attempt: i.attempt, startedAt: i.startedAt, endedAt: i.endedAt, work: i.work ?? null});

export class ViewTokens {
  readonly stages = new StageIndex();
  #folded = 0;
  /** Seq of the last event, and of the last event per category the views depend on (0: none yet). */
  seq = 0; parks = 0; waiting = 0; money = 0; audits = 0;
  /** The first and the last event's time, and the arc's terminal fact. */
  firstAt: string | null = null; lastAt: string | null = null;
  terminal: Extract<Event, {type: 'fact'}> | null = null;
  #rows = new Map<string, {meta: Buffer; resources: Buffer}>();
  readonly #meta = Buffer.alloc(32);
  readonly #resources = Buffer.alloc(32);
  /** Folds the events not yet seen (`events` is the same journal, grown). */
  extend(events: readonly Event[]): void {
    for (let i = this.#folded; i < events.length; i++) {
      const ev = events[i]!;
      this.seq = ev.seq; this.firstAt ??= ev.at; this.lastAt = ev.at;
      if (ev.type === 'fact') {
        if (PARKS.has(ev.fact.kind)) this.parks = ev.seq;
        if (MONEY.has(ev.fact.kind)) this.money = ev.seq;
        if (AUDITS.has(ev.fact.kind)) this.audits = ev.seq;
        if (ev.fact.kind === 'stage-admitted') this.waiting = ev.seq;
        if (ev.fact.kind === 'arc-completed' || ev.fact.kind === 'stop-completed') this.terminal = ev;
      }
      if ((ev.type === 'intent' || ev.type === 'done') && ev.kind === 'resource.transition') this.waiting = ev.seq;
    }
    this.stages.extend(events, this.#folded);
    this.#folded = events.length;
  }
  /** Takes in new or changed rows: two hashes each. */
  rows(rows: readonly Invocation[]): void {
    for (const row of rows) {
      const old = this.#rows.get(row.id);
      if (old) { xor(this.#meta, old.meta); xor(this.#resources, old.resources); }
      const next = {meta: digest(projection(row)), resources: digest(resourceProjection(row))};
      xor(this.#meta, next.meta); xor(this.#resources, next.resources);
      this.#rows.set(row.id, next);
    }
  }
  /** The rows' digests: order-free, so a revision hashes these rather than every row. */
  invocations(): Readonly<{count: number; digest: string; resources: string}> {
    return {count: this.#rows.size, digest: this.#meta.toString('hex'), resources: this.#resources.toString('hex')};
  }
}

const registered = new WeakMap<ObservationData, ViewTokens>();
/** A serve model's tokens stand for the data it published at their position, and for nothing after. */
export function registerTokens(data: ObservationData, tokens: ViewTokens): void { registered.set(data, tokens); }
export function unregisterTokens(data: ObservationData): void { registered.delete(data); }
/** The tokens of `data`: its model's, or built from its events and rows. */
export function tokensFor(data: ObservationData): ViewTokens {
  let tokens = registered.get(data);
  if (tokens === undefined) {
    tokens = new ViewTokens(); tokens.extend(data.events); tokens.rows(data.display.invocations);
    registered.set(data, tokens);
  }
  return tokens;
}
