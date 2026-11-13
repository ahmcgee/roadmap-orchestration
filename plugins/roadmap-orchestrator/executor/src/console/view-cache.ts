// The serve worker's views kept per capture (src/console/worker.ts): a tab's list view, built on its first request per capture
// (and warmed for the next), and a unit's, a milestone's or an Activity event's detail, built once per published data object.
// One bounded cache, least recently used first.
import { canonicalJson } from '../core/json.ts';
import { type Envelope, captureKey } from '../observation/protocol.ts';

const TAB_SECTIONS = new Set(['activity', 'timeline', 'effort', 'resources', 'attention', 'holistic']);
/** A tab's list view (its first page): what `warm` builds before anyone asks. */
export const isTabList = (path: readonly string[], params: Record<string, string>): boolean =>
  TAB_SECTIONS.has(path[2] ?? '') && (path.length === 3 || path[2] === 'timeline' && path.length === 4 && (path[3] === 'intervals' || path[3] === 'holds'))
  && params['cursor'] === undefined && params['anchor'] === undefined;
/**
 * A unit's, a milestone's or an Activity event's detail. A drawer or a hover card asks again on every Activity or Graph version;
 * a check publishes no new data (src/console/model.ts), so none is built again for one.
 */
export const isDetail = (path: readonly string[]): boolean =>
  path.length === 4 && (path[2] === 'units' || path[2] === 'milestones' || path[2] === 'activity' && path[3] !== 'changes');
/** A cached view's key: its path and query, without the admission-only parameters a notice carried (they do not change it). */
export function viewKey(path: readonly string[], params: Record<string, string>): string {
  const { minHighWater: _minHighWater, revision: _revision, ...query } = params;
  return `${path.join('/')}?${canonicalJson(query)}`;
}
/**
 * What a cached view was built from: a tab list, its capture (a rows refresh keeps it); a detail, the published data object,
 * which the envelope's revision names within its capture (a capture or a rows refresh; a check makes none).
 */
const sourceOf = (path: readonly string[], params: Record<string, string>, e: Envelope): string =>
  isTabList(path, params) ? captureKey(e) : `${captureKey(e)}:${e.revision}`;

export class CaptureViews {
  readonly #views = new Map<string, Readonly<{ source: string; data: unknown }>>();
  readonly #size: number;
  constructor(size: number) { this.#size = size; }
  get size(): number { return this.#views.size; }
  /** Whether `path` is kept here. */
  static cached(path: readonly string[], params: Record<string, string>): boolean { return isTabList(path, params) || isDetail(path); }
  /** Whether `path`'s view for `e` is kept. */
  has(path: readonly string[], params: Record<string, string>, e: Envelope): boolean {
    return this.#views.get(viewKey(path, params))?.source === sourceOf(path, params, e);
  }
  /** `path`'s view of `e` (a path `cached` says is kept): the kept one when it was built from `e`'s source, else `build`'s, kept. */
  read<T extends { data: unknown }>(path: readonly string[], params: Record<string, string>, e: Envelope, build: () => T): T | Envelope<unknown> {
    const key = viewKey(path, params), source = sourceOf(path, params, e), hit = this.#views.get(key);
    if (hit?.source === source) { this.#views.delete(key); this.#views.set(key, hit); return { ...e, data: hit.data }; }
    const value = build();
    this.#views.delete(key); this.#views.set(key, { source, data: value.data });
    while (this.#views.size > this.#size) this.#views.delete(this.#views.keys().next().value!);
    return value;
  }
}
