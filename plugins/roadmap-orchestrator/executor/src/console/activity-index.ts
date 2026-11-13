// Typed summaries and source references over a verified prefix. No report sweep,
// transcript parsing, canonical blobs or alternate execution-state fold.
//
// One index per arc and journal epoch, extended with each capture rather than built again (`ActivityIndexer.extend`). Each
// entry is made from one source, a journal event or a root decision, and from state folded from the whole journal and the
// capture's rows; every lookup of that state names what it read (`#read`), and a change of what was read makes the entry
// again. A build from nothing is the same fold from the start (`buildActivityIndex`), so an extended index is the built
// one by construction; test/console-activity-extend.test.ts holds the two equal at every capture.
//
// The inputs, and how each is kept current within an epoch:
// - journal events: append-only within an epoch, folded once each from the index's position on (`extends` refuses a
//   journal that does not grow the folded one);
// - stage steps (StageIndex): a later stage outcome of a step changes what earlier entries of that step show: `step:`;
// - finding claims and decision-request digests: the last `finding-opened` and `needsuser.raise` of an id: `finding:`, `raise:`;
// - invocation rows (`display.invocations`): a row object the capture replaced, or one whose op, charge or unit title
//   moved, is derived again (`#row`); a changed interval or group membership makes its entries again: `route:`, `group:`;
//   group members keep the display order (open by start, settled newest first, then spawn order);
// - meters and spawn outcomes: re-derive the rows they charge or settle (an invocation that ends);
// - unit titles and membership (`identityIndex`, from the plan and the estate): `title:`;
// - backend holds: a hold's start and closing boundary are entries at their own events; the holds list (closures,
//   `terminalAt` from the terminal fact, which a later stop or restart moves) is made again whenever either changes;
// - root decisions (`status.decisionsSince`): made again when the list changes, or while one names an event not yet seen;
// - milestones and units: read whole from the capture (a few hundred values);
// - decision-request records: write-once files, published between the raise's intent and its done; read when the entry
//   is made and again at the done (`raise:`). A record pruned after that keeps the entry as made (an anchored source event
//   is not erased), and the page and detail report the pruning.
import { createHash } from 'node:crypto';
import type { Event } from '../core/events.ts';
import { invocationDirName, invocationIdOf, invocationId, parseInvocationId, needsUserId } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import { needsUserRecord, type NeedsUserRecord } from '../core/records.ts';
import { needsUserPath } from '../needsuser.ts';
import { displayOrder } from '../observation/invocations.ts';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import type { Invocation } from '../tui/types.ts';
import { chargeOf, intervalOf, subjectOf, type SpawnOutcome } from './tab-projections.ts';
import { readEvidence } from './evidence.ts';
import { preview } from './views.ts';
import { nextTerminal } from './tokens.ts';
import { activityKeys, BackendHoldFold } from './backend-holds.ts';
import { displayInvocation, identityIndex, StageIndex, type UnitIdentity } from './indexes.ts';
import { backendWords, holdClassWords, outcomeWords, plainWords, runOutcomeWords, stageWords } from './vocabulary.ts';
import type { ActivityRow, ActivityKind, ActivityFacets, Actor, BackendHold } from './activity-protocol.ts';
import type { Subject, Money, Interval } from './view-protocol.ts';

export type RequestRef = {id: string; sha256: string};
export type ActivityEntry = {row: ActivityRow; actors: Actor[]; invocations: string[]; request: RequestRef | null; search: string};
/** The index at one position. Immutable: the next position is another value, sharing the entries that did not change. */
export type ActivityIndex = Readonly<{
  version: string; bytes: number; entries: readonly ActivityEntry[]; holds: readonly BackendHold[];
  units: readonly string[]; milestones: readonly Readonly<{id: string; units: string[]}>[]; facets: ActivityFacets;
}>;
/** D9: never trust a query path or cached/open record in place of its recorded digest. */
export function activityRequest(e: Envelope, ref: RequestRef): NeedsUserRecord | null {
  let bytes: Buffer;
  try { bytes = readEvidence(e.data.display.run.runDir, needsUserPath(e.data.display.run.runDir, needsUserId(ref.id))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (sha256Hex(bytes) !== ref.sha256) throw new ConsoleError('invalid', 'retained request does not match its recorded digest');
  const r = needsUserRecord(JSON.parse(bytes.toString('utf8')), 'Activity request');
  if (r.id !== ref.id || r.arc !== e.arc) throw new ConsoleError('corruption', 'request identity does not match this Arc');
  return r;
}
const aggregateMoney = (rows: Interval[]): Money | null => {
  if (!rows.length) return null;
  const sum: Money = {costUsd: null, recorded: 0, estimated: 0, unavailable: 0};
  for (const i of rows) {
    if (i.spend.costUsd !== null) sum.costUsd = (sum.costUsd ?? 0) + i.spend.costUsd;
    sum.recorded += i.spend.recorded; sum.estimated += i.spend.estimated; sum.unavailable += i.spend.unavailable;
  }
  return sum;
};
/** Entries in index order: by seq, then id. */
export const compareEntries = (a: ActivityEntry, b: ActivityEntry): number => a.row.seq - b.row.seq || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0);
/** The first position in `entries` (index order) whose seq is past `seq`. */
export function firstAfter(entries: readonly ActivityEntry[], seq: number): number {
  let lo = 0, hi = entries.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (entries[mid]!.row.seq <= seq) lo = mid + 1; else hi = mid; }
  return lo;
}
/** An entry's retained size and digest: an index's size and identity are their sums, kept as entries come and go. */
type Meta = Readonly<{digest: Buffer; bytes: number}>;
const META = new WeakMap<ActivityEntry, Meta>();
/** The retained size of an entry (its serialization). */
export const entryBytes = (entry: ActivityEntry): number => META.get(entry)!.bytes;
function meta(entry: ActivityEntry): Meta {
  let m = META.get(entry);
  if (m === undefined) {
    // Actors and entries are built in a fixed key order, so their JSON is already canonical for identity and hashing.
    const json = JSON.stringify(entry);
    m = {digest: createHash('sha256').update(json).digest(), bytes: Buffer.byteLength(json)};
    META.set(entry, m);
  }
  return m;
}
const xor = (into: Buffer, d: Buffer): void => { for (let i = 0; i < 32; i++) into[i]! ^= d[i]!; };
/** How many events (or sources) are folded between two yields of a build or an extension. */
const SLICE = 2_000;
type FactEvent = Extract<Event, {type: 'fact'}>;
type FindingOpened = Extract<FactEvent['fact'], {kind: 'finding-opened'}>;
type Fields = Partial<Omit<ActivityRow, 'result'>> & {result?: string};
/** What the index keeps of one invocation row: its interval and the groups the entries find it by. */
type Row = Readonly<{row: Invocation; route: string; titleUnit: string | null; interval: Interval; agent: boolean; groups: readonly string[]; key: string}>;
/** The facet fields counted over entries: a value is offered while an entry carries it. */
type Counted = 'stage' | 'role' | 'model' | 'outcome';
const COUNTED: readonly Counted[] = ['stage', 'role', 'model', 'outcome'];
const facetValues = (entry: ActivityEntry, field: Counted): string[] =>
  field === 'stage' ? (entry.row.stage ? [entry.row.stage] : []) : field === 'outcome' ? (entry.row.outcome ? [entry.row.outcome] : [])
    : entry.actors.flatMap(a => a[field] ? [a[field]!] : []);
const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b, 'en', {numeric: true}));
/** The event of `seq` (events are in seq order), or undefined. */
function eventAt(events: readonly Event[], seq: number): Event | undefined {
  let lo = 0, hi = events.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid]!.seq < seq) lo = mid + 1; else hi = mid; }
  return events[lo]?.seq === seq ? events[lo] : undefined;
}
/** What an extension did: the index at the new position, and the entries of the previous one it no longer holds. */
export type Extended = Readonly<{index: ActivityIndex; dropped: readonly ActivityEntry[]}>;

/** The Activity index of one arc and journal epoch, folded from its journal and extended with each capture. */
export class ActivityIndexer {
  readonly epoch: string;
  readonly arc: string;
  readonly #key: (seq: number, kind: ActivityKind) => string;
  readonly #arcSubject: Subject;
  #index: ActivityIndex = {version: '', bytes: 0, entries: [], holds: [], units: [], milestones: [],
    facets: {unit: [], milestone: [], stage: [], role: [], backend: ['claude', 'codex'], model: [], outcome: []}};
  /** The events folded, and the last of them. */
  #folded = 0;
  #last: Event | null = null;
  readonly #stages = new StageIndex();
  /** Each invocation's spawn intent's position in the journal: the display order's tie-break. */
  readonly #spawns = new Map<string, number>();
  readonly #charges = new Map<string, Money>();
  readonly #terminals = new Map<string, SpawnOutcome>();
  readonly #findings = new Map<string, FindingOpened>();
  readonly #raises = new Map<string, RequestRef>();
  readonly #raiseOps = new Map<string, string>();
  readonly #holds: BackendHoldFold;
  #terminal: FactEvent | null = null;
  readonly #rows = new Map<string, Row>();
  readonly #routes = new Map<string, Row>();
  /** Invocation ids by group (`op:`, `job:`, `step:<unit>:<stage>:<attempt>`). */
  readonly #groups = new Map<string, Set<string>>();
  #rowsSeen: readonly Invocation[] | null = null;
  #identities: ReadonlyMap<string, UnitIdentity> = new Map();
  /** The sources (event positions) that read each named input: a change of the input makes them again. */
  readonly #reads = new Map<string, number | Set<number>>();
  #decisions: Readonly<{key: string; missing: boolean; entries: readonly ActivityEntry[]}> = {key: '[]', missing: false, entries: []};
  readonly #xor = Buffer.alloc(32);
  #entryBytes = 0;
  readonly #counts: Record<Counted, Map<string, number>> = {stage: new Map(), role: new Map(), model: new Map(), outcome: new Map()};
  #holdsJson = '[]';
  #busy = false;
  /** An extension failed or was abandoned part way: the fold is not at any position, and the index must be built again. */
  broken = false;
  constructor(epoch: string, arc: string) {
    this.epoch = epoch; this.arc = arc; this.#key = activityKeys(epoch); this.#holds = new BackendHoldFold(epoch);
    this.#arcSubject = {type: 'arc', id: arc, title: 'Arc'};
  }
  /** The index at the position last extended to. */
  get index(): ActivityIndex { return this.#index; }
  /** The events folded. */
  get folded(): number { return this.#folded; }
  /** Whether `e`'s journal is this index's grown (or as it stands). Within an epoch the journal is append-only and verified. */
  extends(e: Envelope): boolean {
    if (this.broken || e.epoch !== this.epoch || e.arc !== this.arc) return false;
    const events = e.data.events, last = this.#last;
    if (events.length < this.#folded) return false;
    if (last === null) return true;
    const at = events[this.#folded - 1]!;
    return at === last || at.seq === last.seq && JSON.stringify(at) === JSON.stringify(last);
  }
  /**
   * Extends the index to `e`'s position, yielding between slices of the work; the new index becomes visible only when the
   * extension completes. One extension at a time: a second one started meanwhile is a fault.
   */
  *extend(e: Envelope): Generator<undefined, Extended, undefined> {
    if (this.#busy) throw new Error('the Activity index of one arc is being extended twice at once');
    if (!this.extends(e)) throw new Error('the Activity index cannot extend to a journal that does not grow its own');
    this.#busy = true;
    let done = false;
    try { const extended = yield* this.#extend(e); done = true; return extended; }
    finally { this.#busy = false; if (!done) this.broken = true; }
  }
  *#extend(e: Envelope): Generator<undefined, Extended, undefined> {
    const events = e.data.events, from = this.#folded, terminal = this.#terminal;
    // Inputs that changed, by name; the ops and invocations whose rows' intervals may move.
    const changed = new Set<string>(), ops = new Set<string>(), invs = new Set<string>();
    let holds = false;
    for (let i = from; i < events.length; i++) {
      if ((i - from) % SLICE === SLICE - 1) yield;
      const ev = events[i]!;
      this.#terminal = nextTerminal(this.#terminal, ev);
      if (this.#holds.fold(ev)) holds = true;
      if (ev.type === 'intent') {
        ops.add(String(ev.op));
        if (ev.kind === 'proc.spawn') this.#spawns.set(invocationId(ev.op, ev.ordinal), i);
        else if (ev.kind === 'needsuser.raise') {
          const id = String(ev.expect.id);
          this.#raises.set(id, {id, sha256: ev.post.sha256}); this.#raiseOps.set(String(ev.op), id); changed.add(`raise:${id}`);
        }
      } else if (ev.type === 'done' && ev.kind === 'proc.spawn') { this.#terminals.set(String(ev.op), ev.outcome); ops.add(String(ev.op)); }
      // The record is published between the raise's intent and its done (src/needsuser.ts): read again once it is.
      else if (ev.type === 'done' && ev.kind === 'needsuser.raise') { const id = this.#raiseOps.get(String(ev.op)); if (id !== undefined) changed.add(`raise:${id}`); }
      else if (ev.type === 'fact') {
        const f = ev.fact;
        if (f.kind === 'meter' || f.kind === 'usage-unavailable') { this.#charges.set(f.inv, chargeOf(f)); invs.add(f.inv); }
        else if (f.kind === 'finding-opened') { this.#findings.set(String(f.id), f); changed.add(`finding:${f.id}`); }
        else if (f.kind === 'stage-outcome' && 'unit' in f) changed.add(`step:${f.unit}:${f.attempt}`);
      }
    }
    this.#stages.extend(events, from);
    this.#folded = events.length; this.#last = events.at(-1) ?? null;

    const identities = identityIndex(e), titled = new Set<string>();
    if (identities !== this.#identities) {
      const title = (m: ReadonlyMap<string, UnitIdentity>, unit: string) => m.get(unit)?.title.slice(0, 96);
      for (const unit of new Set([...this.#identities.keys(), ...identities.keys()])) {
        if (title(this.#identities, unit) !== title(identities, unit)) { titled.add(unit); changed.add(`title:${unit}`); }
      }
      this.#identities = identities;
    }
    // Rows the capture replaced, then rows whose op, charge or title moved.
    const rows = e.data.display.invocations, derived = new Set<string>();
    if (rows !== this.#rowsSeen) {
      const before = this.#rows.size;
      let present = 0;
      for (const row of rows) {
        const kept = this.#rows.get(row.id);
        if (kept !== undefined) present++;
        if (kept?.row !== row) { this.#row(row, changed); derived.add(row.id); }
      }
      if (present < before) {
        const ids = new Set(rows.map(r => r.id));
        for (const id of [...this.#rows.keys()]) if (!ids.has(id)) this.#drop(id, changed);
      }
      this.#rowsSeen = rows;
    }
    const recheck = new Set<string>(invs);
    for (const op of ops) for (const id of this.#groups.get(`op:${op}`) ?? []) recheck.add(id);
    if (titled.size) for (const [id, r] of this.#rows) if (r.titleUnit !== null && titled.has(r.titleUnit)) recheck.add(id);
    for (const id of recheck) { const kept = this.#rows.get(id); if (kept !== undefined && !derived.has(id)) this.#row(kept.row, changed); }

    // Sources to make: every appended event, and every earlier source that read a changed input.
    const again = new Set<number>();
    for (const name of changed) {
      const read = this.#reads.get(name);
      if (typeof read === 'number') { if (read < from) again.add(read); }
      else if (read !== undefined) for (const n of read) if (n < from) again.add(n);
    }
    const made = new Map<number, ActivityEntry[]>();
    let n = 0;
    for (const i of again) { made.set(i, this.#produce(e, i)); if (++n % SLICE === 0) yield; }
    for (let i = from; i < events.length; i++) { const out = this.#produce(e, i); if (out.length) made.set(i, out); if (++n % SLICE === 0) yield; }
    // D10 root decisions can share a source event; subkind is part of their stable identity.
    const decisions = e.data.display.status.decisionsSince, decisionKey = JSON.stringify(decisions), prior = this.#decisions;
    if (decisionKey !== prior.key || prior.missing && events.length > from) {
      let missing = false; const entries: ActivityEntry[] = [];
      for (const d of decisions) {
        const ev = eventAt(events, d.seq); if (!ev) { missing = true; continue; }
        entries.push(this.#entry(ev, 'decision', `${d.id}: ${d.oneLine}`, {outcome: d.kind}, [], null, d.id));
      }
      this.#decisions = {key: decisionKey, missing, entries};
    }
    yield;
    return this.#commit(e, made, prior, holds || this.#terminal !== terminal);
  }
  /** Publishes the next index: the made entries in place of their sources' earlier ones. */
  #commit(e: Envelope, made: ReadonlyMap<number, readonly ActivityEntry[]>, decisions: Readonly<{entries: readonly ActivityEntry[]}>, holdsMoved: boolean): Extended {
    const prior = this.#index.entries, events = e.data.events;
    const replaced = new Map<ActivityEntry, ActivityEntry>(), removed = new Set<ActivityEntry>(), inserted: ActivityEntry[] = [];
    /** Puts `fresh` in place of `old`; returns the entries the index now holds for them. */
    const swap = (old: readonly ActivityEntry[], fresh: readonly ActivityEntry[]): ActivityEntry[] => {
      const byId = new Map(old.map(x => [x.row.id, x]));
      const held = fresh.map(entry => {
        const was = byId.get(entry.row.id);
        if (was === undefined) { inserted.push(entry); return entry; }
        byId.delete(entry.row.id);
        // Made again unchanged: the entry readers already hold stays.
        if (meta(was).digest.equals(meta(entry).digest)) return was;
        replaced.set(was, entry); return entry;
      });
      for (const was of byId.values()) removed.add(was);
      return held;
    };
    for (const [i, fresh] of made) {
      const seq = events[i]!.seq, old: ActivityEntry[] = [];
      for (let p = firstAfter(prior, seq - 1); p < prior.length && prior[p]!.row.seq === seq; p++) if (prior[p]!.row.kind !== 'decision') old.push(prior[p]!);
      swap(old, fresh);
    }
    if (this.#decisions.entries !== decisions.entries) this.#decisions = {...this.#decisions, entries: swap(decisions.entries, this.#decisions.entries)};
    inserted.sort(compareEntries);
    const count = (entry: ActivityEntry, by: 1 | -1) => {
      const m = meta(entry); xor(this.#xor, m.digest); this.#entryBytes += by * m.bytes;
      for (const field of COUNTED) for (const value of facetValues(entry, field)) {
        const counts = this.#counts[field], next = (counts.get(value) ?? 0) + by;
        if (next === 0) counts.delete(value); else counts.set(value, next);
      }
    };
    for (const [was, now] of replaced) { count(was, -1); count(now, 1); }
    for (const was of removed) count(was, -1);
    for (const now of inserted) count(now, 1);
    let entries: ActivityEntry[];
    const last = prior.at(-1);
    if (removed.size === 0 && (inserted.length === 0 || last === undefined || compareEntries(inserted[0]!, last) > 0)) {
      entries = prior.slice();
      for (const [was, now] of replaced) {
        let p = firstAfter(entries, was.row.seq - 1);
        while (entries[p] !== was) p++;
        entries[p] = now;
      }
      for (const now of inserted) entries.push(now);
    } else {
      // An entry made for an earlier position than the last (a row read after its spawn was folded): merged into place.
      entries = [];
      let k = 0;
      for (const x of prior) {
        if (removed.has(x)) continue;
        const kept = replaced.get(x) ?? x;
        while (k < inserted.length && compareEntries(inserted[k]!, kept) < 0) entries.push(inserted[k++]!);
        entries.push(kept);
      }
      while (k < inserted.length) entries.push(inserted[k++]!);
    }
    let held = this.#index.holds;
    if (holdsMoved) { held = this.#holds.holds(this.#terminal); this.#holdsJson = JSON.stringify(held); }
    const units = [...this.#identities.keys()];
    const milestones = e.data.display.status.milestones.map(m => ({id: String(m.id), units: m.members.map(String)}));
    const shape = JSON.stringify({units, milestones});
    const facets: ActivityFacets = {unit: units, milestone: milestones.map(m => m.id), stage: sorted(this.#counts.stage.keys()),
      role: sorted(this.#counts.role.keys()), backend: ['claude', 'codex'], model: sorted(this.#counts.model.keys()), outcome: sorted(this.#counts.outcome.keys())};
    this.#index = {version: sha256Hex(`${this.#xor.toString('hex')}\n${entries.length}\n${shape}`),
      bytes: this.#entryBytes + Buffer.byteLength(shape) + Buffer.byteLength(this.#holdsJson), entries, holds: held, units, milestones, facets};
    return {index: this.#index, dropped: [...replaced.keys(), ...removed]};
  }
  /** Derives one row again: its interval, agent kind and groups; a change names it and its groups. */
  #row(recorded: Invocation, changed: Set<string>): void {
    const i = displayInvocation(recorded), inv = invocationIdOf(i.id), {op} = parseInvocationId(inv), route = invocationDirName(inv);
    const parent = this.#stages.parents.get(op), step = parent?.type === 'stage' ? this.#stages.steps.get(`${parent.unit}:${parent.attempt}`) : undefined;
    const interval = intervalOf(i, parent, step, this.#terminals.get(String(op)), this.#charges.get(i.id), subjectOf(this.#identities, this.arc, parent, i.unit));
    const groups = [`op:${op}`, ...(parent?.type === 'job' ? [`job:${parent.job}`] : parent?.type === 'stage' ? [`step:${parent.unit}:${parent.stage}:${parent.attempt}`] : [])];
    const agent = i.execution === 'agent', key = JSON.stringify([interval, agent, groups]);
    const old = this.#rows.get(i.id);
    const row: Row = {row: recorded, route, titleUnit: parent?.type === 'stage' ? parent.unit : parent?.type === 'job' ? null : i.unit ?? null, interval, agent, groups, key};
    this.#rows.set(i.id, row); this.#routes.set(route, row);
    if (old?.key === key) return;
    changed.add(`route:${route}`);
    for (const g of old?.groups ?? []) if (!groups.includes(g)) { this.#groups.get(g)!.delete(i.id); changed.add(`group:${g}`); }
    for (const g of groups) {
      let members = this.#groups.get(g);
      if (members === undefined) this.#groups.set(g, members = new Set());
      members.add(i.id); changed.add(`group:${g}`);
    }
  }
  #drop(id: string, changed: Set<string>): void {
    const old = this.#rows.get(id)!;
    this.#rows.delete(id); this.#routes.delete(old.route); changed.add(`route:${old.route}`);
    for (const g of old.groups) { this.#groups.get(g)!.delete(id); changed.add(`group:${g}`); }
  }
  /** `value`, noting that source `src` read the input `name`. */
  #read<T>(name: string, src: number, value: T): T {
    const read = this.#reads.get(name);
    if (read === undefined) this.#reads.set(name, src);
    else if (typeof read === 'number') { if (read !== src) this.#reads.set(name, new Set([read, src])); }
    else read.add(src);
    return value;
  }
  #unit(id: string, src: number): Subject {
    return {type: 'unit', id, title: this.#read(`title:${id}`, src, this.#identities.get(id))?.title.slice(0, 96) ?? id};
  }
  /** A group's routes in display order. */
  #group(name: string, src: number): string[] {
    const members = [...this.#read(`group:${name}`, src, this.#groups.get(name)) ?? []].map(id => this.#rows.get(id)!);
    members.sort((a, b) => displayOrder(a.row, b.row) || (this.#spawns.get(a.row.id) ?? 0) - (this.#spawns.get(b.row.id) ?? 0));
    return members.map(r => r.route);
  }
  /** The entries of the event at `src`. */
  #produce(e: Envelope, src: number): ActivityEntry[] {
    const ev = e.data.events[src]!, out: ActivityEntry[] = [];
    const add = (kind: ActivityKind, text: string, fields: Fields = {}, refs: readonly string[] = [], request: RequestRef | null = null) => {
      out.push(this.#entry(ev, kind, text, fields, refs, request));
    };
    const unit = (id: string) => this.#unit(id, src);
    if (ev.type === 'intent' && ev.kind === 'needsuser.raise') {
      const ref = this.#read(`raise:${ev.expect.id}`, src, this.#raises.get(String(ev.expect.id)))!, request = activityRequest(e, ref);
      add('request-raised', `Decision requested: ${request?.summary ?? `Request ${ref.id}; evidence pruned`}`,
        {subject: !request ? {type: 'request', id: ref.id, title: 'Decision request'} : request.subject.type === 'unit' ? unit(request.subject.unit)
          : request.subject.type === 'arc' ? this.#arcSubject : {type: request.subject.type, id: null, title: request.subject.type === 'host' ? 'Host' : 'Findings'}, outcome: 'raised', ...(request ? {result: request.summary} : {})}, [], ref);
    } else if (ev.type === 'intent' && ev.kind === 'proc.spawn') {
      const route = invocationDirName(invocationId(ev.op, ev.ordinal)), i = this.#read(`route:${route}`, src, this.#routes.get(route))?.interval;
      if (i) add('invocation-started', `${stageWords(i.stage)} run started`, {subject: i.subject, stage: i.stage, attempt: i.attempt, round: i.round, outcome: 'started', workMs: null, spend: null}, [i.id]);
    } else if (ev.type === 'done' && ev.kind === 'proc.spawn') {
      const refs = this.#group(`op:${ev.op}`, src), i = refs.length === 1 ? this.#routes.get(refs[0]!)!.interval : null;
      if (i) add('invocation-ended', `${stageWords(i.stage)} run: ${runOutcomeWords(i.outcome)}`, {subject: i.subject, stage: i.stage, attempt: i.attempt, round: i.round, outcome: i.outcome}, [i.id]);
      else if (refs.length) add('invocation-ended', 'Runs finished; several attempts recorded', {outcome: ev.outcome.kind}, refs);
    } else if (ev.type === 'fact') {
      const f = ev.fact;
      if (f.kind === 'stage-outcome' && 'unit' in f) {
        const step = this.#read(`step:${f.unit}:${f.attempt}`, src, this.#stages.steps.get(`${f.unit}:${f.attempt}`)), refs = this.#group(`step:${f.unit}:${f.stage}:${f.attempt}`, src);
        add('stage-outcome', `${f.unit}: ${stageWords(f.stage)} — ${step?.outcome ?? f.outcome}`,
          {subject: unit(f.unit), stage: f.stage, attempt: step?.attempt ?? null, round: step?.round ?? null,
            outcome: f.outcome, result: step?.outcome ?? outcomeWords(f.outcome), housekeeping: step?.housekeeping ?? false}, refs);
      } else if (f.kind === 'stage-outcome') {
        add('stage-outcome', `${stageWords(f.stage)}: ${f.verdict}`, {subject: {type: 'job', id: f.job, title: f.job}, stage: f.stage, outcome: f.verdict}, this.#group(`job:${f.job}`, src));
      } else if (f.kind === 'plan-applied') add(f.kind, `Plan revision ${f.rev} applied`, {outcome: 'applied'});
      else if (f.kind === 'arc-completed' || f.kind === 'stop-completed') add(f.kind, f.kind === 'arc-completed' ? 'Arc completed' : 'Arc stopped', {outcome: f.kind === 'arc-completed' ? 'completed' : 'stopped'});
      else if (f.kind === 'needs-user-acked') add('request-acknowledged', `Decision request ${f.id} answered`, {outcome: 'acknowledged'}, [], this.#read(`raise:${f.id}`, src, this.#raises.get(String(f.id))) ?? null);
      else if (f.kind === 'audit-started' || f.kind === 'audit-ended') {
        add(f.kind, f.kind === 'audit-started' ? 'Holistic audit started' : `Holistic audit ${f.outcome}: ${f.findings.length} ${f.findings.length === 1 ? 'finding' : 'findings'}`,
          {subject: {type: 'job', id: f.job, title: f.job}, outcome: f.kind === 'audit-started' ? 'started' : f.outcome, ...(f.kind === 'audit-ended' ? {result: `${plainWords(f.outcome)}, ${f.findings.length} new ${f.findings.length === 1 ? 'finding' : 'findings'}`} : {})}, f.kind === 'audit-ended' ? this.#group(`job:${f.job}`, src) : []);
      } else if (f.kind === 'finding-opened' || f.kind === 'finding-transition') {
        const finding = this.#read(`finding:${f.id}`, src, this.#findings.get(String(f.id))), source = finding?.source;
        const subject = source?.type === 'stage' ? unit(source.unit) : source?.type === 'job' ? {type: 'job' as const, id: source.job, title: source.job} : this.#arcSubject;
        add(f.kind, `${f.id}: ${finding?.claim ?? 'Finding'} — ${f.kind === 'finding-opened' ? 'open' : f.to.state}`,
          {subject, outcome: f.kind === 'finding-opened' ? 'open' : f.to.state, result: `${f.id}: ${finding?.claim ?? 'Finding'} (${plainWords(f.kind === 'finding-opened' ? 'open' : f.to.state)})`});
      } else if (f.kind === 'backend-park') {
        // A hold's start and class are known at its own event.
        const h = this.#holds.starts.get(ev.seq)!;
        add('backend-park', `${backendWords(f.backend)} unavailable to new calls: ${holdClassWords(h.effectiveClass).toLowerCase()}`,
          {actor: {role: null, backend: f.backend, model: null}, actorCount: 1, outcome: h.effectiveClass});
      }
      const closed = this.#holds.closures.get(ev.seq);
      if (closed) add('backend-closure', `${backendWords(closed.backend)} available again (${closed.closure!.kind === 'probe' ? 'a check passed' : 'resumed'})`,
        {actor: {role: null, backend: closed.backend, model: null}, actorCount: 1, outcome: 'available'});
    }
    return out;
  }
  #entry(ev: Event, kind: ActivityKind, text: string, fields: Fields, refs: readonly string[], request: RequestRef | null, subkey = ''): ActivityEntry {
    const id = this.#key(ev.seq, kind) + (subkey ? `-${sha256Hex(subkey).slice(0, 24)}` : ''), detail = {type: 'event' as const, id};
    const joined = refs.flatMap(r => { const row = this.#routes.get(r); return row ? [row] : []; }), completed = joined.filter(r => r.interval.endedAt !== null);
    const measured = completed.filter(r => r.interval.wallMs !== null), actors = new Map<string, Actor>();
    // Actors and entries are built here in a fixed key order, so their JSON is already canonical for identity and hashing.
    for (const r of joined) actors.set(JSON.stringify(r.interval.actor), r.interval.actor);
    if (fields.actor) actors.set(JSON.stringify(fields.actor), fields.actor);
    const row: ActivityRow = {id, seq: ev.seq, at: ev.at, kind, subject: this.#arcSubject, stage: null, attempt: null, round: null,
      actor: actors.size === 1 ? [...actors.values()][0]! : null, actorCount: actors.size,
      outcome: null, summary: preview(text, detail), workMs: measured.length ? measured.reduce((n, r) => n + r.interval.wallMs!, 0) : null,
      spend: aggregateMoney(joined.filter(r => r.agent).map(r => r.interval)), coverage: {measured: measured.length, unmeasured: joined.length - measured.length},
      detail, housekeeping: false, ...fields, result: fields.result === undefined ? null : preview(fields.result, detail)};
    const search = [row.summary.text, row.subject.id, row.subject.title, row.stage, row.stage ? stageWords(row.stage) : null, row.outcome, request?.id,
      ...[...actors.values()].flatMap(a => [a.role, a.backend, a.model])].filter(v => v != null).join(' ').toLowerCase();
    return {row, actors: [...actors.values()], invocations: [...refs], request, search};
  }
}
/** The index of `e` built from nothing: the same fold, from the journal's start. */
export function buildActivityIndex(e: Envelope): ActivityIndex {
  const steps = new ActivityIndexer(e.epoch, e.arc).extend(e);
  for (;;) { const step = steps.next(); if (step.done) return step.value.index; }
}
