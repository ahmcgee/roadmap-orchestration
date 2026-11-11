// One maintained arc as the serve worker holds it: the latest observation its collector published, with the clock overlay,
// and the journal's events parsed here from the verified prefix the collector names (parsed events are never copied between
// threads). Reads are answered from this; nothing here reads a record, stats the run or derives status.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../cli/locate.ts';
import { type Event, parseEventLine } from '../core/events.ts';
import { invocationId } from '../core/ids.ts';
import { EVENTS_FILE } from '../core/log.ts';
import type { NeedsUserRecord } from '../core/records.ts';
import type { IsoTime } from '../core/values.ts';
import type { PlanM1 } from '../input/plan.ts';
import type { CaptureWork, CollectorMessage, JournalPosition, Summary } from '../observation/collect.ts';
import { exceptionsOf } from '../observation/observer.ts';
import { type Admission, type ConsoleCode, type Envelope, type ObservationData, CONSOLE_PROTOCOL, ConsoleError } from '../observation/protocol.ts';
import type { Status } from '../status.ts';
import type { Entry, Invocation } from '../tui/types.ts';
import type { Supervision } from '../watch-lease.ts';
import { ViewTokens, registerTokens, unregisterTokens } from './tokens.ts';

/** Why a read waits: no observation yet, its watermark is ahead, or (a strict read) nothing was verified since it arrived. */
export type ParkKind = 'cold' | 'watermark' | 'strict';
export type Verdict = Readonly<{ kind: 'ready'; envelope: Envelope }> | Readonly<{ kind: 'park'; park: ParkKind }>;
/** What an applied message changed: the published envelope (a notice to main), or nothing anyone reads. */
export type Applied = 'published' | 'checked' | 'none';
type Base = Readonly<{ run: Run; clock: number; foldMs: number; seq: number; status: Status; summary: Summary; plan: PlanM1 | null;
  requests: readonly NeedsUserRecord[]; milestoneUnits: Record<string, readonly string[]>; estate: readonly Entry[]; work: CaptureWork }>;

const SLICE_MS = 20, CHUNK = 1 << 20;
const sortRows = (rows: Invocation[], order: ReadonlyMap<string, number>): Invocation[] =>
  rows.sort((a, b) => Number(a.endedAt !== null) - Number(b.endedAt !== null) || (a.endedAt === null ? a.startedAt.localeCompare(b.startedAt) : b.endedAt!.localeCompare(a.endedAt))
    || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

/** The journal as parsed here: complete lines of the verified prefix the collector named, up to `target`. */
class ParsedJournal {
  readonly epoch: string;
  readonly identity: string;
  readonly path: string;
  events: Event[] = [];
  /** Each invocation's spawn intent's position in the journal: the display order's tie-break, as the collector's table keeps it. */
  readonly order = new Map<string, number>();
  offset = 0;
  target = 0;
  #utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  constructor(path: string, epoch: string, identity: string) { this.path = path; this.epoch = epoch; this.identity = identity; }
  /** Parses toward `target` for at most `budgetMs` (Infinity: to the end). False when the file is not the journal named. */
  parse(budgetMs: number): boolean {
    if (this.offset >= this.target) return true;
    const fd = openSync(this.path, 'r');
    try {
      const st = fstatSync(fd);
      if (`${st.dev}:${st.ino}` !== this.identity) return false;
      const until = performance.now() + budgetMs, chunk = Buffer.alloc(Math.min(CHUNK, this.target - this.offset));
      let carry = Buffer.alloc(0), pos = this.offset;
      while (pos < this.target && performance.now() < until) {
        const got = readSync(fd, chunk, 0, Math.min(chunk.length, this.target - pos), pos);
        if (got === 0) throw new Error(`${this.path}: the verified prefix ends at ${this.target}, but the file ends at ${pos}`);
        pos += got;
        const buf = carry.length === 0 ? chunk.subarray(0, got) : Buffer.concat([carry, chunk.subarray(0, got)]);
        let start = 0;
        for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
          const event = parseEventLine(this.#utf8.decode(buf.subarray(start, nl)));
          if (event.type === 'intent' && event.kind === 'proc.spawn') this.order.set(invocationId(event.op, event.ordinal), this.events.length);
          this.events.push(event);
          this.offset += nl + 1 - start;
          start = nl + 1;
        }
        carry = Buffer.from(buf.subarray(start));
      }
      return true;
    } finally { closeSync(fd); }
  }
}

export class ArcModel {
  readonly run: Run;
  readonly #instance: string;
  readonly #repoId: string;
  failed: Readonly<{ code: ConsoleCode; message: string }> | null = null;
  journal: JournalPosition = { identity: '', offset: 0, size: 0, seq: 0 };
  checkedAt = 0;
  #epoch = '';
  #revision = 0;
  #observedAt = 0;
  #materializations = 0;
  #base: Base | null = null;
  #rows = new Map<string, Invocation>();
  #sorted: Invocation[] = [];
  #events: readonly Event[] = [];
  #parsed: ParsedJournal | null = null;
  #pumping = false;
  #overlay: Readonly<{ at: number; heartbeatAt: IsoTime | null; supervision: Supervision }> | null = null;
  #envelope: Envelope | null = null;
  #exceptions: Entry[] = [];
  /** The always-current views' inputs at the published position, and the data objects they stand for (src/console/tokens.ts). */
  #tokens = new ViewTokens();
  #registered: ObservationData[] = [];
  /** Called when a journal parse sliced across turns of the event loop finished a slice: nothing to publish, but reads may wait on it. */
  readonly #onSlice: () => void;
  constructor(run: Run, instance: string, repoId: string, onSlice: () => void = () => {}) { this.run = run; this.#instance = instance; this.#repoId = repoId; this.#onSlice = onSlice; }
  get epoch(): string { return this.#epoch; }
  get revision(): number { return this.#revision; }
  /** Which capture the published data is: view caches key on this, not on `revision`, which also moves with the clock overlay. */
  get capture(): string { return `${this.#epoch}:${this.#materializations}`; }
  get observed(): boolean { return this.#base !== null; }

  apply(m: CollectorMessage, now: number): Applied {
    switch (m.kind) {
      case 'progress': case 'log': return 'none';
      case 'journal': {
        this.#parser(m.epoch, m.identity).target = Math.max(this.#parsed!.target, m.offset);
        this.#pump();
        return 'none';
      }
      // A failure is what a check found: verified as of `at`.
      case 'failed': this.failed = m.error; this.checkedAt = Math.max(this.checkedAt, m.at); return 'published';
      case 'observation': {
        const parsed = this.#parser(m.epoch, m.journal.identity);
        parsed.target = Math.max(parsed.target, m.journal.offset);
        // The journal was replaced after this capture verified it: the next capture reads the new one.
        if (!parsed.parse(Infinity)) return 'none';
        if (m.epoch !== this.#epoch) { this.#rows.clear(); this.#sorted = []; this.#epoch = m.epoch; this.#tokens = new ViewTokens(); }
        this.#events = parsed.events.slice(0, parsed.events.length);
        this.#retire();
        this.#tokens.extend(this.#events); this.#tokens.rows(m.rows);
        this.#upsert(m.rows, parsed.order);
        this.#base = { run: m.run, clock: m.clock, foldMs: m.foldMs, seq: m.journal.seq, status: m.status, summary: m.summary, plan: m.plan,
          requests: m.requests, milestoneUnits: m.milestoneUnits, estate: m.estate ?? this.#base!.estate, work: m.work };
        this.journal = m.journal; this.failed = null; this.#overlay = null;
        this.#publish(m.asOf);
        return 'published';
      }
      case 'rows': {
        if (this.#base === null || m.epoch !== this.#epoch) return 'none';
        this.#retire();
        this.#tokens.rows(m.rows);
        this.#upsert(m.rows, this.#parsed!.order);
        this.#base = { ...this.#base, work: m.work };
        this.#publish(m.asOf);
        return 'published';
      }
      case 'checked': {
        this.checkedAt = Math.max(this.checkedAt, m.at);
        if (this.#base === null) return 'none';
        const s = this.#base.status;
        const moving = s.units.some((u) => u.running !== null || u.waitingFor?.tokenWaitMs != null) || this.#sorted.some((i) => i.endedAt === null);
        const volatile = this.#overlay ?? { heartbeatAt: s.run.heartbeatAt, supervision: s.supervision };
        if (!moving && volatile.heartbeatAt === m.heartbeatAt && JSON.stringify(volatile.supervision) === JSON.stringify(m.supervision)) {
          this.#envelope = { ...this.#envelope!, checkedAt: new Date(this.checkedAt).toISOString() };
          return 'checked';
        }
        // A heartbeat changes no immutable evidence or plan. Live elapsed times advance from the capture's clock.
        this.#overlay = { at: m.at, heartbeatAt: m.heartbeatAt, supervision: m.supervision };
        this.#revision++; this.#observedAt = m.at;
        this.#envelope = this.#build();
        return 'published';
      }
    }
  }
  /**
   * Whether a read that arrived at `arrivedAt` can be answered now. A watermark ahead of the published one waits for an
   * observation reaching it, and is unavailable once a check made after the read arrived found nothing newer. A strict read
   * needs a check made after it arrived, covering its fence.
   */
  admit(admission: Admission, arrivedAt: number, strict: boolean): Verdict {
    // A strict read is answered by what a check made after it arrived found, a failure included.
    if (strict && this.checkedAt < arrivedAt) return { kind: 'park', park: this.#envelope === null && this.failed === null ? 'cold' : 'strict' };
    if (this.failed !== null) throw new ConsoleError(this.failed.code, this.failed.message);
    const e = this.#envelope;
    if (e === null) return { kind: 'park', park: 'cold' };
    if (admission.epoch !== undefined && admission.epoch !== e.epoch) throw new ConsoleError('reset', `journal epoch changed to ${e.epoch}`);
    if ((admission.revision ?? 0) > e.revision) throw new ConsoleError('conflict', 'requested revision is ahead of this server');
    if ((admission.minHighWater ?? 0) > e.highWater) {
      if (this.checkedAt >= arrivedAt) throw new ConsoleError('unavailable', 'requested watermark is not yet verified');
      return { kind: 'park', park: 'watermark' };
    }
    if (strict) {
      if (this.checkedAt < arrivedAt) return { kind: 'park', park: 'strict' };
      if (admission.fence) {
        if (admission.fence.identity !== this.journal.identity) throw new ConsoleError('reset', 'journal fence identity changed');
        if (this.journal.size < admission.fence.size) return { kind: 'park', park: 'strict' };
      }
    }
    return { kind: 'ready', envelope: e };
  }
  /** The published envelope; null before the first observation. */
  envelope(): Envelope | null { return this.#envelope; }
  /** The last capture's work counts. */
  work(): CaptureWork | null { return this.#base?.work ?? null; }

  #parser(epoch: string, identity: string): ParsedJournal {
    if (this.#parsed === null || this.#parsed.epoch !== epoch || this.#parsed.identity !== identity) this.#parsed = new ParsedJournal(join(this.run.runDir, EVENTS_FILE), epoch, identity);
    return this.#parsed;
  }
  /** Parses toward the named prefix in slices, one per turn of the event loop, so reads of other arcs are answered between them. */
  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    const slice = () => {
      const parsed = this.#parsed;
      if (parsed === null || parsed.offset >= parsed.target || !parsed.parse(SLICE_MS)) { this.#pumping = false; return; }
      this.#onSlice();
      setImmediate(slice);
    };
    setImmediate(slice);
  }
  #upsert(rows: readonly Invocation[], order: ReadonlyMap<string, number>): void {
    if (rows.length === 0) return;
    for (const row of rows) this.#rows.set(row.id, row);
    this.#sorted = sortRows([...this.#rows.values()], order);
  }
  #publish(asOf: number): void {
    this.#materializations++; this.#revision++;
    this.#observedAt = asOf; this.checkedAt = Math.max(this.checkedAt, asOf);
    this.#exceptions = exceptionsOf(this.#base!.status, this.#base!.requests, this.#sorted);
    this.#envelope = this.#build();
  }
  /** The tokens are about to move past the published position: they no longer stand for the data published at it. */
  #retire(): void { for (const data of this.#registered) unregisterTokens(data); this.#registered = []; }
  #build(): Envelope {
    const e = this.#assemble();
    // Only the latest data object is registered: an older one (an earlier overlay) gets tokens built from its own events.
    this.#retire();
    registerTokens(e.data, this.#tokens); this.#registered.push(e.data);
    return e;
  }
  #assemble(): Envelope {
    const b = this.#base!, o = this.#overlay;
    const display = { run: b.run, at: new Date(b.clock).toISOString(), seq: b.seq, status: b.status, invocations: this.#sorted, estate: b.estate as Entry[],
      exceptions: this.#exceptions, milestoneUnits: b.milestoneUnits };
    let data: ObservationData = { requests: b.requests, display, summary: b.summary, events: this.#events, plan: b.plan,
      capture: { clock: b.clock, foldMs: b.foldMs, materializations: this.#materializations, work: b.work } };
    if (o !== null) {
      const delta = o.at - b.clock, s = b.status;
      const units = s.units.map((u) => ({ ...u,
        running: u.running === null ? null : { ...u.running, elapsed: u.running.elapsed === null ? null : u.running.elapsed + delta },
        waitingFor: u.waitingFor === null ? null : { ...u.waitingFor, ...(typeof u.waitingFor.tokenWaitMs === 'number' ? { tokenWaitMs: u.waitingFor.tokenWaitMs + delta } : {}) },
      }));
      data = { ...data, display: { ...display, at: new Date(o.at).toISOString(), status: { ...s, units, run: { ...s.run, heartbeatAt: o.heartbeatAt }, supervision: o.supervision },
        invocations: this.#sorted.map((i) => i.endedAt !== null || i.quietMs === null ? i : { ...i, quietMs: i.quietMs + delta }) },
        summary: { ...b.summary, supervision: o.supervision } };
    }
    return { protocol: CONSOLE_PROTOCOL, instance: this.#instance, repoId: this.#repoId, arc: this.run.arc, epoch: this.#epoch,
      highWater: b.seq, revision: this.#revision, observedAt: new Date(this.#observedAt).toISOString(), checkedAt: new Date(this.checkedAt).toISOString(), data };
  }
}
