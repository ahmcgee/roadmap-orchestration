// Immutable, bounded query generations. Only typed summaries and lookup references
// are retained: never observations, event bodies, transcripts or report objects.
import { createHmac, randomBytes } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { ACTIVITY_KINDS, type ActivityFilters, type ActivityView, type ActivityChanges } from './activity-protocol.ts';
import { activityRequest, buildActivityIndex, type ActivityEntry, type ActivityIndex } from './activity-index.ts';
import { versioned } from './views.ts';

export const ACTIVITY_RETENTION = {bytes: 32 * 1024 * 1024, indexes: 8, queries: 32, idleMs: 15 * 60 * 1000} as const;
const admission = ['epoch', 'revision', 'minHighWater'];
const common = ['from', 'to', 'window', 'zone', 'afterSeq', 'beforeSeq', 'unit', 'milestone', 'stage', 'kind', 'role', 'backend', 'model', 'outcome', 'q', 'housekeeping', 'order', 'limit'];
type Query = {filters: ActivityFilters; limit: number; window: 'arc' | '24h' | '7d' | null; hash: string};
type StoredIndex = {index: ActivityIndex; bytes: number; touched: number};
type Generation = {
  indexKey: string; query: Query; keys: number[]; bytes: number; touched: number; revision: number;
  instance: string; repoId: string; arc: string; epoch: string;
  asOf: {epoch: string; highWater: number; observedAt: string};
};
type Token = {generation: string; indexVersion: string; anchorHighWater: number; filterHash: string;
  instance: string; repoId: string; arc: string; epoch: string; limit: number; order: 'asc' | 'desc';
  lastKey: [number, string] | null; direction: 'next' | 'previous' | null};
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
function checkFilters(index: ActivityIndex, query: Query) {
  const f = query.filters;
  for (const [field, known] of [
    ['unit', index.units], ['milestone', index.milestones.map(m => m.id)],
    ['stage', index.entries.flatMap(e => e.row.stage ? [e.row.stage] : [])],
    ['role', index.entries.flatMap(e => e.actors.flatMap(a => a.role ? [a.role] : []))],
    ['backend', ['claude', 'codex']], ['model', index.entries.flatMap(e => e.actors.flatMap(a => a.model ? [a.model] : []))],
    ['outcome', index.entries.flatMap(e => e.row.outcome ? [e.row.outcome] : [])],
  ] as const) if (f[field].some(value => !(known as readonly string[]).includes(value))) invalid(`unknown Activity ${field} filter`);
}
const keyOf = (e: ActivityEntry): [number, string] => [e.row.seq, e.row.id];
const compare = (a: [number, string], b: [number, string]) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
function matches(entry: ActivityEntry, filters: ActivityFilters, index: ActivityIndex): boolean {
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
  return !f.q || entry.search.includes(f.q.toLowerCase());
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function bounded<T>(e: Envelope, data: T, ceiling: number): T {
  if (bytes({...e, data}) + 1 > ceiling) throw new ConsoleError('unavailable', 'Activity response exceeds its byte ceiling; narrow the range or page size');
  return data;
}
export class ConsoleActivity {
  #secret = randomBytes(32);
  #indexes = new Map<string, StoredIndex>();
  #queries = new Map<string, Generation>();
  #bytes = 0;
  #sign(raw: string) {return createHmac('sha256', this.#secret).update(raw).digest('hex');}
  #token(generation: string, lastKey: Token['lastKey'] = null, direction: Token['direction'] = null) {
    const g = this.#queries.get(generation)!, index = this.#indexes.get(g.indexKey)!.index;
    const raw = Buffer.from(JSON.stringify({generation, indexVersion: index.version, anchorHighWater: g.asOf.highWater, filterHash: g.query.hash,
      instance: g.instance, repoId: g.repoId, arc: g.arc, epoch: g.epoch, limit: g.query.limit, order: g.query.filters.order, lastKey, direction} satisfies Token)).toString('base64url');
    return `${raw}.${this.#sign(raw)}`;
  }
  #dropQuery(key: string) {const g = this.#queries.get(key); if (g) this.#bytes -= g.bytes; this.#queries.delete(key);}
  #dropIndex(key: string) {
    const i = this.#indexes.get(key); if (i) this.#bytes -= i.bytes; this.#indexes.delete(key);
    for (const [id, g] of this.#queries) if (g.indexKey === key) this.#dropQuery(id);
  }
  #sweep() {
    const now = Date.now();
    for (const [id, g] of this.#queries) if (now - g.touched > ACTIVITY_RETENTION.idleMs) this.#dropQuery(id);
    for (const [key, i] of this.#indexes) if (now - i.touched > ACTIVITY_RETENTION.idleMs) this.#dropIndex(key);
    while (this.#queries.size > ACTIVITY_RETENTION.queries) this.#dropQuery(this.#queries.keys().next().value!);
    while (this.#indexes.size > ACTIVITY_RETENTION.indexes || this.#bytes > ACTIVITY_RETENTION.bytes && this.#indexes.size) this.#dropIndex(this.#indexes.keys().next().value!);
  }
  index(e: Envelope): ActivityIndex {
    this.#sweep();
    const key = this.#indexKey(e), old = this.#indexes.get(key);
    if (old) {old.touched = Date.now(); this.#indexes.delete(key); this.#indexes.set(key, old); return old.index;}
    const index = buildActivityIndex(e), size = bytes(index);
    if (size > ACTIVITY_RETENTION.bytes) throw new ConsoleError('unavailable', 'Activity index exceeds retained capacity');
    this.#indexes.set(key, {index, bytes: size, touched: Date.now()}); this.#bytes += size; this.#sweep();
    return index;
  }
  #indexKey(e: Envelope) {return sha256Hex(canonicalJson([e.instance, e.repoId, e.arc, e.epoch, e.data.capture.source]));}
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
    const g = this.#queries.get(parsed.generation), index = g ? this.#indexes.get(g.indexKey) : null;
    if (!g || !index || index.index.version !== parsed.indexVersion || g.asOf.highWater !== parsed.anchorHighWater) return reset();
    if (e.highWater < g.asOf.highWater || e.revision < g.revision) return reset();
    g.touched = index.touched = Date.now(); this.#queries.delete(parsed.generation); this.#queries.set(parsed.generation, g);
    this.#indexes.delete(g.indexKey); this.#indexes.set(g.indexKey, index);
    return {id: parsed.generation, g, parsed};
  }
  page(e: Envelope, params: Record<string, string>): ActivityView {
    for (const key of Object.keys(params)) if (![...admission, ...common, 'cursor'].includes(key)) invalid('unknown Activity query parameter');
    const query = queryOf(params);
    let id: string, g: Generation, lastKey: Token['lastKey'] = null, direction: Token['direction'] = null;
    if (params['cursor']) {
      const cursor = this.#admit(e, params['cursor'], query, false); id = cursor.id; g = cursor.g; ({lastKey, direction} = cursor.parsed);
    } else {
      const index = this.index(e); checkFilters(index, query);
      // Resolve a relative range once. Continuations retain these exact bounds.
      const terminal = e.data.events.findLast(ev => ev.type === 'fact' && ['arc-completed', 'stop-completed'].includes(ev.fact.kind));
      if (query.window === '24h' || query.window === '7d') {
        const end = Date.parse(terminal?.at ?? e.checkedAt), start = end - (query.window === '24h' ? 1 : 7) * 86400_000;
        query.filters.from = new Date(start).toISOString(); query.filters.to = new Date(end).toISOString();
      }
      const keys = index.entries.flatMap((entry, n) => matches(entry, query.filters, index) ? [n] : []);
      if (query.filters.order === 'desc') keys.reverse();
      id = randomBytes(12).toString('hex');
      g = {indexKey: this.#indexKey(e), query, keys, bytes: bytes(keys) + bytes(query) + 512, touched: Date.now(), revision: e.revision,
        instance: e.instance, repoId: e.repoId, arc: e.arc, epoch: e.epoch, asOf: {epoch: e.epoch, highWater: e.highWater, observedAt: e.observedAt}};
      this.#queries.set(id, g); this.#bytes += g.bytes; this.#sweep(); if (!this.#queries.has(id)) return reset();
    }
    const index = this.#indexes.get(g.indexKey)!.index, order = g.query.filters.order === 'asc' ? 1 : -1;
    const keys = g.keys.filter(n => !lastKey || (direction === 'next' ? compare(keyOf(index.entries[n]!), lastKey) * order > 0 : compare(keyOf(index.entries[n]!), lastKey) * order < 0));
    const selected = direction === 'previous' ? keys.slice(-g.query.limit) : keys.slice(0, g.query.limit);
    const first = selected[0], last = selected.at(-1), start = first === undefined ? 0 : g.keys.indexOf(first), end = last === undefined ? 0 : g.keys.indexOf(last) + 1;
    const rows = selected.map(n => {
      const entry = index.entries[n]!; if (entry.request) activityRequest(e, entry.request); return entry.row;
    });
    const days = new Map<string, number>(), formatter = new Intl.DateTimeFormat('en-CA', {timeZone: g.query.filters.zone, year: 'numeric', month: '2-digit', day: '2-digit'});
    for (const n of g.keys) {const day = formatter.format(new Date(index.entries[n]!.row.at)); days.set(day, (days.get(day) ?? 0) + 1);}
    const data: ActivityView = {...versioned({rows, filters: g.query.filters, membership: 'applied-plan-at-anchor' as const,
      days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({date, count})),
      page: {anchor: this.#token(id), next: end < g.keys.length && last !== undefined ? this.#token(id, keyOf(index.entries[last]!), 'next') : null,
        previous: start > 0 && first !== undefined ? this.#token(id, keyOf(index.entries[first]!), 'previous') : null,
        limit: g.query.limit, matching: g.keys.length, returned: rows.length, asOf: g.asOf}},
    {basis: 'recorded-arc', from: g.query.filters.from, to: g.query.filters.to}), viewVersion: index.version};
    return bounded(e, data, g.query.limit === 100 ? 128 * 1024 : 64 * 1024);
  }
  changes(e: Envelope, params: Record<string, string>): ActivityChanges {
    for (const key of Object.keys(params)) if (![...admission, ...common, 'anchor'].includes(key)) invalid('unknown Activity changes query parameter');
    if (!params['anchor']) return invalid('Activity changes requires an anchor');
    const query = queryOf(params), {g} = this.#admit(e, params['anchor'], query, true), index = this.index(e);
    const newMatching = index.entries.filter(entry => entry.row.seq > g.asOf.highWater && matches(entry, g.query.filters, index)).length;
    return bounded(e, {...versioned({newMatching, latestHighWater: e.highWater, latestViewVersion: index.version}, {basis: 'recorded-arc', from: g.query.filters.from, to: g.query.filters.to}), viewVersion: index.version}, 2 * 1024);
  }
}
