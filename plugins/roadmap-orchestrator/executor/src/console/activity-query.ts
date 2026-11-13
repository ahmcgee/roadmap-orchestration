// Immutable, bounded query generations. Only typed summaries and lookup references
// are retained: never observations, event bodies, transcripts or report objects.
//
// Memory law. The index is not a cache: it is the one copy of what Activity serves for an arc the serve worker maintains,
// one per arc, of its current epoch (a new epoch's index replaces it), dropped when the worker stops maintaining the arc
// (`release`). It is never refused or evicted for its size: it grows with the arc by its own law (src/console/activity-index.ts,
// a fixed cost per entry), and is bounded by the serve worker's heap guard, which scales with the journals it parses
// (src/console/http.ts `NEED`). The caches are the query generations (an anchor and its cursors), frozen at their position:
// each holds references to its matching entries (eight bytes each), its days and its query, and an entry the index has since
// replaced or dropped is kept alive by the generations that hold it and counted in theirs. Generations stay within `bytes`,
// `queries` and `idleMs`; past a bound the least recently used goes, and its tab's count of new events answers `reset`
// ("Updates available." with "Show latest"), its cursors `reset` (reload the view). A generation does not depend on an index.
import { createHmac, randomBytes } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { COLLECTION_RETENTION } from './collection-pages.ts';
import { ConsoleError, captureKey, type Envelope } from '../observation/protocol.ts';
import { ACTIVITY_KINDS, type ActivityFacets, type ActivityFilters, type ActivityView, type ActivityChanges } from './activity-protocol.ts';
import { ActivityIndexer, activityRequest, compareEntries, entryBytes, firstAfter, searchText, type ActivityEntry, type ActivityIndex } from './activity-index.ts';
import { versioned } from './views.ts';
import { arcTerminal } from './tokens.ts';

// The query generations' bounds. Eight MiB are reserved for other typed collections' summaries: together they stay at 32 MiB.
export const ACTIVITY_RETENTION = {bytes: 32 * 1024 * 1024 - COLLECTION_RETENTION.bytes, queries: 32, idleMs: 15 * 60 * 1000} as const;
const admission = ['epoch', 'revision', 'minHighWater'];
const common = ['from', 'to', 'window', 'zone', 'afterSeq', 'beforeSeq', 'unit', 'milestone', 'stage', 'kind', 'role', 'backend', 'model', 'outcome', 'q', 'housekeeping', 'order', 'limit'];
type Query = {filters: ActivityFilters; limit: number; window: 'arc' | '24h' | '7d' | null; hash: string};
/** An arc's index and the Activity version it stands for (`key`). */
type Kept = {indexer: ActivityIndexer; key: string};
type Generation = {
  /** The arc (instance, repository, arc) and epoch it was issued in. */
  arcKey: string; epoch: string;
  query: Query; entries: readonly ActivityEntry[]; facets: ActivityFacets; days: {date: string; count: number}[];
  indexVersion: string; bytes: number; touched: number; revision: number;
  instance: string; repoId: string; arc: string;
  asOf: {epoch: string; highWater: number; observedAt: string};
};
type Token = {generation: string; indexVersion: string; anchorHighWater: number; filterHash: string;
  instance: string; repoId: string; arc: string; epoch: string; limit: number; order: 'asc' | 'desc';
  lastKey: [number, string] | null; direction: 'next' | 'previous' | null};
export type ActivitySizes = Readonly<{indexes: number; entries: number; bytes: number; queries: number; queryBytes: number; built: number; extended: number}>;
const invalid = (message: string): never => {throw new ConsoleError('invalid', message);};
const reset = (): never => {throw new ConsoleError('reset', 'Activity page expired or changed; reload this view');};
function integer(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid('sequence must be a non-negative safe integer');
  return Number(value);
}
function instant(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return invalid('time range must use RFC3339 instants');
  const [, y, month, day, h, min, s, offset] = m;
  const leap = Number(y) % 4 === 0 && (Number(y) % 100 !== 0 || Number(y) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(month) - 1]!;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days || Number(h) > 23 || Number(min) > 59 || Number(s) > 59
    || offset !== 'Z' && (Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59) || !Number.isFinite(Date.parse(value))) return invalid('impossible time range');
  return new Date(value).toISOString();
}
function queryOf(params: Record<string, string>): Query {
  const filters: ActivityFilters = {from: params['from'] === undefined ? null : instant(params['from']), to: params['to'] === undefined ? null : instant(params['to']),
    afterSeq: params['afterSeq'] === undefined ? null : integer(params['afterSeq']), beforeSeq: params['beforeSeq'] === undefined ? null : integer(params['beforeSeq']),
    unit: [], milestone: [], stage: [], kind: [], role: [], backend: [], model: [], outcome: [], q: params['q'] ?? '', housekeeping: params['housekeeping'] === '1', order: 'desc', zone: params['zone'] ?? 'UTC'};
  if (params['window'] !== undefined && (filters.from !== null || filters.to !== null)) invalid('window cannot be combined with from/to');
  const window = params['window'] ?? (filters.from === null && filters.to === null ? 'arc' : null);
  if (window !== null && !['arc', '24h', '7d'].includes(window)) invalid('unsupported Activity window');
  if (filters.from && filters.to && filters.from >= filters.to) invalid('from must precede to');
  if (filters.afterSeq !== null && filters.beforeSeq !== null && filters.afterSeq >= filters.beforeSeq) invalid('afterSeq must precede beforeSeq');
  if (filters.afterSeq !== null && params['epoch'] === undefined) invalid('afterSeq requires its journal epoch');
  if (filters.q.length > 200) invalid('Activity summary search is limited to 200 characters');
  if (params['housekeeping'] !== undefined && !['0', '1'].includes(params['housekeeping'])) invalid('housekeeping is 0 or 1');
  if (params['order'] !== undefined && !['asc', 'desc'].includes(params['order'])) invalid('order is asc or desc');
  filters.order = (params['order'] ?? 'desc') as 'asc' | 'desc';
  if (/^[+-]/.test(filters.zone)) invalid('invalid IANA timezone');
  try {new Intl.DateTimeFormat('en', {timeZone: filters.zone});} catch {invalid('invalid IANA timezone');}
  for (const key of ['unit', 'milestone', 'stage', 'kind', 'role', 'backend', 'model', 'outcome'] as const) {
    if (params[key] === undefined) continue;
    const values = params[key].split(',');
    if (values.some(v => !v) || new Set(values).size !== values.length) invalid('multi-select filters use distinct comma-separated values');
    (filters[key] as string[]) = values.sort();
  }
  if (filters.kind.some(k => !(ACTIVITY_KINDS as readonly string[]).includes(k))) invalid('unsupported Activity kind');
  const limit = Number(params['limit'] ?? '50');
  if (!['25', '50', '100'].includes(params['limit'] ?? '50')) invalid('Activity limit is 25, 50 or 100');
  return {filters, window: window as Query['window'], limit, hash: sha256Hex(canonicalJson({filters: {...filters, q: filters.q.toLowerCase()}, window, limit}))};
}
function checkFilters(facets: ActivityFacets, query: Query) {
  const f = query.filters;
  for (const field of ['unit', 'milestone', 'stage', 'role', 'backend', 'model', 'outcome'] as const)
    if (f[field].some(value => !facets[field].includes(value))) invalid(`unknown Activity ${field} filter`);
}
const keyOf = (e: ActivityEntry): [number, string] => [e.row.seq, e.row.id];
const compare = (a: [number, string], b: [number, string]) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
function matches(entry: ActivityEntry, filters: ActivityFilters, index: Pick<ActivityIndex, 'milestones'>): boolean {
  const r = entry.row, f = filters;
  // Invocation lifecycle rows are an explicit kind selection, not duplicate default attempt summaries.
  if (!f.kind.length && (r.kind === 'invocation-started' || r.kind === 'invocation-ended')) return false;
  if (!f.housekeeping && r.housekeeping || f.from !== null && Date.parse(r.at) < Date.parse(f.from) || f.to !== null && Date.parse(r.at) >= Date.parse(f.to)
    || f.afterSeq !== null && r.seq <= f.afterSeq || f.beforeSeq !== null && r.seq >= f.beforeSeq) return false;
  const subjectUnit = r.subject.type === 'unit' ? r.subject.id : null;
  if (f.unit.length && (subjectUnit === null || !f.unit.includes(subjectUnit))) return false;
  if (f.milestone.length && (subjectUnit === null || !index.milestones.some(m => f.milestone.includes(m.id) && m.units.includes(subjectUnit)))) return false;
  for (const [selected, value] of [[f.kind, r.kind], [f.stage, r.stage], [f.outcome, r.outcome]] as const) {
    if (selected.length && (value == null || !(selected as readonly string[]).includes(value))) return false;
  }
  if ((f.role.length || f.backend.length || f.model.length) && !entry.actors.some(a =>
    (!f.role.length || a.role !== null && f.role.includes(a.role)) && (!f.backend.length || a.backend !== null && f.backend.includes(a.backend)) && (!f.model.length || a.model !== null && f.model.includes(a.model)))) return false;
  return !f.q || searchText(entry).includes(f.q.toLowerCase());
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function bounded<T>(e: Envelope, data: T, ceiling: number): T {
  if (bytes({...e, data}) + 1 > ceiling) throw new ConsoleError('unavailable', 'Activity response exceeds its byte ceiling; narrow the range or page size');
  return data;
}
/** Whether a generation (its entries in its order) holds `entry`. */
function holds(g: Generation, entry: ActivityEntry): boolean {
  const order = g.query.filters.order === 'asc' ? 1 : -1, entries = g.entries;
  let lo = 0, hi = entries.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (compareEntries(entries[mid]!, entry) * order < 0) lo = mid + 1; else hi = mid; }
  return entries[lo] === entry;
}
export class ConsoleActivity {
  /** What an index stands for: by default its capture; the serve worker passes the Activity view version, so a capture
   * that changed nothing Activity shows (a schedule rewrite, a moved ref) keeps the index as it is. */
  readonly #version: (e: Envelope) => string;
  constructor(version: (e: Envelope) => string = captureKey) { this.#version = version; }
  #secret = randomBytes(32);
  /** One index per arc, of the epoch it was last extended in: kept until `release`, whatever its size. */
  #indexes = new Map<string, Kept>();
  #queries = new Map<string, Generation>();
  /** Indexes built from nothing, and extended, since this worker started (its heap reports). */
  #built = 0;
  #extended = 0;
  #sign(raw: string) {return createHmac('sha256', this.#secret).update(raw).digest('hex');}
  #token(generation: string, lastKey: Token['lastKey'] = null, direction: Token['direction'] = null) {
    const g = this.#queries.get(generation)!;
    const raw = Buffer.from(JSON.stringify({generation, indexVersion: g.indexVersion, anchorHighWater: g.asOf.highWater, filterHash: g.query.hash,
      instance: g.instance, repoId: g.repoId, arc: g.arc, epoch: g.epoch, limit: g.query.limit, order: g.query.filters.order, lastKey, direction} satisfies Token)).toString('base64url');
    return `${raw}.${this.#sign(raw)}`;
  }
  #arcKey(e: Pick<Envelope, 'instance' | 'repoId' | 'arc'>) {return canonicalJson([e.instance, e.repoId, e.arc]);}
  /** What the generations retain. */
  #queryBytes(): number {
    let n = 0;
    for (const g of this.#queries.values()) n += g.bytes;
    return n;
  }
  /** Drops the generations past their bounds, least recently used first. Indexes are not swept. */
  #sweep() {
    const now = Date.now();
    for (const [id, g] of this.#queries) if (now - g.touched > ACTIVITY_RETENTION.idleMs) this.#queries.delete(id);
    while (this.#queries.size > ACTIVITY_RETENTION.queries || this.#queries.size > 0 && this.#queryBytes() > ACTIVITY_RETENTION.bytes) this.#queries.delete(this.#queries.keys().next().value!);
  }
  /** The serve worker no longer maintains `arc`: its index and generations go. */
  release(arc: string): void {
    for (const [key, k] of this.#indexes) if (k.indexer.arc === arc) this.#indexes.delete(key);
    for (const [id, g] of this.#queries) if (g.arc === arc) this.#queries.delete(id);
  }
  index(e: Envelope): ActivityIndex {
    const steps = this.steps(e);
    for (;;) { const step = steps.next(); if (step.done) return step.value; }
  }
  /** Whether `e`'s index is built. */
  has(e: Envelope): boolean {
    const k = this.#indexes.get(this.#arcKey(e));
    return k !== undefined && k.indexer.epoch === e.epoch && k.key === this.#version(e);
  }
  /**
   * `e`'s index, in steps a caller may run one per turn of its event loop (the console's serve worker does): the arc's index
   * extended to `e` when `e`'s journal grows it, else built from nothing (a new epoch, or a journal it does not grow).
   */
  *steps(e: Envelope): Generator<undefined, ActivityIndex, undefined> {
    this.#sweep();
    const arcKey = this.#arcKey(e), key = this.#version(e), kept = this.#indexes.get(arcKey);
    if (kept !== undefined && kept.indexer.epoch === e.epoch && kept.key === key) return kept.indexer.index;
    const extending = kept !== undefined && kept.indexer.extends(e), indexer = extending ? kept.indexer : new ActivityIndexer(e.epoch, e.arc);
    if (extending) this.#extended++; else this.#built++;
    const {index, dropped} = yield* indexer.extend(e);
    // A generation keeps alive what it holds of what the index no longer does.
    if (dropped.length) for (const g of this.#queries.values()) {
      if (g.arcKey !== arcKey || g.epoch !== e.epoch) continue;
      for (const entry of dropped) if (holds(g, entry)) g.bytes += entryBytes(entry);
    }
    // An index of a new epoch: the earlier epoch's anchors can no longer count anything.
    for (const [id, g] of this.#queries) if (g.arcKey === arcKey && g.epoch !== e.epoch) this.#queries.delete(id);
    this.#indexes.set(arcKey, {indexer, key});
    this.#sweep();
    return index;
  }
  /** What this holds, for the serve worker's heap reports: the indexes (entries, retained bytes) and the generations. */
  sizes(): ActivitySizes {
    let entries = 0, bytes = 0;
    for (const k of this.#indexes.values()) { entries += k.indexer.index.entries.length; bytes += k.indexer.index.bytes; }
    return {indexes: this.#indexes.size, entries, bytes, queries: this.#queries.size, queryBytes: this.#queryBytes(), built: this.#built, extended: this.#extended};
  }
  #admit(e: Envelope, token: string, query: Query, anchor: boolean): {id: string; g: Generation; parsed: Token} {
    this.#sweep();
    let parsed: Token;
    try {
      const [raw, sig, ...rest] = token.split('.');
      if (token.length > 2048 || !raw || rest.length || sig !== this.#sign(raw)) throw Error();
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Token;
      if (anchor ? parsed.lastKey !== null || parsed.direction !== null : !Array.isArray(parsed.lastKey) || parsed.lastKey.length !== 2 || !Number.isSafeInteger(parsed.lastKey[0]) || typeof parsed.lastKey[1] !== 'string' || !['next', 'previous'].includes(parsed.direction!)) throw Error();
    } catch {return invalid('invalid Activity cursor or anchor');}
    if (parsed.instance !== e.instance || parsed.repoId !== e.repoId || parsed.arc !== e.arc || parsed.epoch !== e.epoch || parsed.filterHash !== query.hash || parsed.limit !== query.limit || parsed.order !== query.filters.order) invalid('foreign Activity cursor or changed filters');
    // Gone only past the retention bounds (or with a new epoch): within its epoch a generation outlives every index.
    const g = this.#queries.get(parsed.generation);
    if (!g || g.indexVersion !== parsed.indexVersion || g.asOf.highWater !== parsed.anchorHighWater) return reset();
    if (e.highWater < g.asOf.highWater || e.revision < g.revision) return reset();
    g.touched = Date.now(); this.#queries.delete(parsed.generation); this.#queries.set(parsed.generation, g);
    return {id: parsed.generation, g, parsed};
  }
  page(e: Envelope, params: Record<string, string>): ActivityView { return this.pageEntries(e, params).view; }
  /** A page and the entries of its rows, in their order. */
  pageEntries(e: Envelope, params: Record<string, string>): {view: ActivityView; entries: readonly ActivityEntry[]} {
    for (const key of Object.keys(params)) if (![...admission, ...common, 'cursor'].includes(key)) invalid('unknown Activity query parameter');
    const query = queryOf(params);
    let id: string, g: Generation, lastKey: Token['lastKey'] = null, direction: Token['direction'] = null;
    if (params['cursor']) {
      const cursor = this.#admit(e, params['cursor'], query, false); id = cursor.id; g = cursor.g; ({lastKey, direction} = cursor.parsed);
    } else {
      const index = this.index(e); checkFilters(index.facets, query);
      // Resolve a relative range once. Continuations retain these exact bounds.
      const terminal = arcTerminal(e.data);
      if (query.window === '24h' || query.window === '7d') {
        const end = Date.parse(terminal?.at ?? e.checkedAt), start = end - (query.window === '24h' ? 1 : 7) * 86400_000;
        query.filters.from = new Date(start).toISOString(); query.filters.to = new Date(end).toISOString();
      }
      const entries = index.entries.filter(entry => matches(entry, query.filters, index));
      if (query.filters.order === 'desc') entries.reverse();
      const days = new Map<string, number>(), formatter = new Intl.DateTimeFormat('en-CA', {timeZone: query.filters.zone, year: 'numeric', month: '2-digit', day: '2-digit'});
      // Every recorded day stays reachable while one day is selected, so day counts ignore the time range.
      const anyTime = {...query.filters, from: null, to: null};
      for (const entry of index.entries) if (matches(entry, anyTime, index)) {const day = formatter.format(new Date(entry.row.at)); days.set(day, (days.get(day) ?? 0) + 1);}
      const dayCounts = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({date, count}));
      id = randomBytes(12).toString('hex');
      g = {arcKey: this.#arcKey(e), epoch: e.epoch, query, entries, facets: index.facets, days: dayCounts, indexVersion: index.version,
        bytes: 8 * entries.length + bytes(query) + bytes(dayCounts) + 512, touched: Date.now(), revision: e.revision,
        instance: e.instance, repoId: e.repoId, arc: e.arc, asOf: {epoch: e.epoch, highWater: e.highWater, observedAt: e.observedAt}};
      this.#queries.set(id, g); this.#sweep(); if (!this.#queries.has(id)) return reset();
    }
    const order = g.query.filters.order === 'asc' ? 1 : -1;
    const keys = g.entries.filter(entry => !lastKey || (direction === 'next' ? compare(keyOf(entry), lastKey) * order > 0 : compare(keyOf(entry), lastKey) * order < 0));
    const selected = direction === 'previous' ? keys.slice(-g.query.limit) : keys.slice(0, g.query.limit);
    const first = selected[0], last = selected.at(-1), start = first === undefined ? 0 : g.entries.indexOf(first), end = last === undefined ? 0 : g.entries.indexOf(last) + 1;
    const rows = selected.map(entry => {
      if (entry.request) activityRequest(e, entry.request);
      return entry.row;
    });
    const data: ActivityView = {...versioned({rows, filters: g.query.filters, facets: g.facets, membership: 'applied-plan-at-anchor' as const, days: g.days,
        page: {anchor: this.#token(id), next: end < g.entries.length && last !== undefined ? this.#token(id, keyOf(last), 'next') : null,
          previous: start > 0 && first !== undefined ? this.#token(id, keyOf(first), 'previous') : null,
          limit: g.query.limit, matching: g.entries.length, returned: rows.length, asOf: g.asOf}},
      {basis: 'recorded-arc', from: g.query.filters.from, to: g.query.filters.to}), viewVersion: g.indexVersion};
    return {view: bounded(e, data, g.query.limit === 100 ? 128 * 1024 : 64 * 1024), entries: selected};
  }
  /** How many entries newer than an anchor match its query, counted on `e`'s index: the generation is all the anchor needs. */
  changes(e: Envelope, params: Record<string, string>): ActivityChanges {
    for (const key of Object.keys(params)) if (![...admission, ...common, 'anchor'].includes(key)) invalid('unknown Activity changes query parameter');
    if (!params['anchor']) return invalid('Activity changes requires an anchor');
    const query = queryOf(params), {g} = this.#admit(e, params['anchor'], query, true), index = this.index(e);
    const filters = {...g.query.filters};
    if (g.query.window === '24h' || g.query.window === '7d') {
      const terminal = arcTerminal(e.data), end = Date.parse(terminal?.at ?? e.checkedAt);
      filters.from = new Date(end - (g.query.window === '24h' ? 1 : 7) * 86400_000).toISOString(); filters.to = new Date(end).toISOString();
    }
    let newMatching = 0;
    for (let p = firstAfter(index.entries, g.asOf.highWater); p < index.entries.length; p++) if (matches(index.entries[p]!, filters, index)) newMatching++;
    return bounded(e, {...versioned({newMatching, latestHighWater: e.highWater, latestViewVersion: index.version}, {basis: 'recorded-arc', from: g.query.filters.from, to: g.query.filters.to}), viewVersion: index.version}, 2 * 1024);
  }
}
