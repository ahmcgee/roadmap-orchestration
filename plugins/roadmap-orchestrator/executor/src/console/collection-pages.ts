// Immutable typed collections only: no captures, source events, reports or evidence bytes.
import { createHmac, randomBytes } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import type { Page } from './view-protocol.ts';

export const COLLECTION_RETENTION = {bytes: 8 * 1024 * 1024, queries: 32, idleMs: 15 * 60 * 1000} as const;
type Generation = {identity: string; query: string; revision: number; touched: number; bytes: number; rows: {id: string}[]; context: object; asOf: Page<never>['page']['asOf']};
type Token = {generation: string; identity: string; query: string; limit: number; last: string | null; direction: 'next' | 'previous' | null};
const reset = (): never => {throw new ConsoleError('reset', 'View page expired or changed; reload this view');};
export function responseBound<T>(e: Envelope, data: T, ceiling: number): T {
  if (Buffer.byteLength(JSON.stringify({...e, data})) + 1 > ceiling) throw new ConsoleError('unavailable', 'View response exceeds its byte ceiling; choose a smaller page or narrower scope');
  return data;
}
/** Keys refer to an immutable sorted population; continuation never re-sorts current records. */
export class CollectionPages {
  #secret = randomBytes(32);
  #queries = new Map<string, Generation>();
  #bytes = 0;
  #identity(e: Envelope) {return sha256Hex(canonicalJson([e.instance, e.repoId, e.arc, e.epoch]));}
  #sign(raw: string) {return createHmac('sha256', this.#secret).update(raw).digest('hex');}
  #token(id: string, limit: number, last: string | null = null, direction: Token['direction'] = null) {
    const g = this.#queries.get(id)!;
    const raw = Buffer.from(JSON.stringify({generation: id, identity: g.identity, query: g.query, limit, last, direction} satisfies Token)).toString('base64url');
    return `${raw}.${this.#sign(raw)}`;
  }
  #drop(id: string) {const g = this.#queries.get(id); if (g) this.#bytes -= g.bytes; this.#queries.delete(id);}
  #sweep() {
    for (const [id, g] of this.#queries) if (Date.now() - g.touched > COLLECTION_RETENTION.idleMs) this.#drop(id);
    while (this.#queries.size > COLLECTION_RETENTION.queries || this.#bytes > COLLECTION_RETENTION.bytes) this.#drop(this.#queries.keys().next().value!);
  }
  page<T extends {id: string}, C extends object>(e: Envelope, route: string, query: object, limit: number, cursor: string | undefined, build: () => {rows: T[]; context: C}): Page<T> & C {
    this.#sweep();
    const identity = this.#identity(e), hash = sha256Hex(canonicalJson([route, query, limit]));
    let id: string, g: Generation, last: string | null = null, direction: Token['direction'] = null;
    if (cursor !== undefined) {
      let token: Token;
      try {
        const [raw, sig, ...rest] = cursor.split('.');
        if (cursor.length > 2048 || !raw || rest.length || sig !== this.#sign(raw)) throw Error();
        token = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (!token || !['next','previous'].includes(token.direction!) || typeof token.last !== 'string') throw Error();
      } catch {throw new ConsoleError('invalid', 'invalid view cursor');}
      if (token.identity !== identity || token.query !== hash || token.limit !== limit) throw new ConsoleError('invalid', 'foreign view cursor or changed query');
      id = token.generation; g = this.#queries.get(id) ?? reset();
      if (g.identity !== identity || g.query !== hash || e.highWater < g.asOf.highWater || e.revision < g.revision) reset();
      ({last, direction} = token); g.touched = Date.now();
      this.#queries.delete(id); this.#queries.set(id, g);
    } else {
      const built = build();
      if (new Set(built.rows.map(r => r.id)).size !== built.rows.length) throw new ConsoleError('protocol', 'typed collection keys must be unique');
      id = randomBytes(12).toString('hex');
      // Clone before retention: caller mutations cannot alter an already issued ordering.
      const {rows, context} = structuredClone(built);
      g = {identity, query: hash, revision: e.revision, touched: Date.now(), bytes: Buffer.byteLength(JSON.stringify(built)) + 512, rows, context,
        asOf: {epoch: e.epoch, highWater: e.highWater, observedAt: e.observedAt}};
      if (g.bytes > COLLECTION_RETENTION.bytes) throw new ConsoleError('unavailable', 'Typed collection exceeds retained capacity');
      this.#queries.set(id, g); this.#bytes += g.bytes; this.#sweep();
    }
    const key = last === null ? -1 : g.rows.findIndex(r => r.id === last);
    if (last !== null && key < 0) reset();
    const start = direction === 'previous' ? Math.max(0, key - limit) : direction === 'next' ? key + 1 : 0;
    const end = direction === 'previous' ? key : Math.min(start + limit, g.rows.length);
    const rows = g.rows.slice(start, end) as T[];
    return {...structuredClone(g.context) as C, rows: structuredClone(rows), page: {anchor: this.#token(id, limit),
      next: end < g.rows.length && rows.length ? this.#token(id, limit, rows.at(-1)!.id, 'next') : null,
      previous: start > 0 && rows.length ? this.#token(id, limit, rows[0]!.id, 'previous') : null,
      limit, matching: g.rows.length, returned: rows.length, asOf: {...g.asOf}}};
  }
}
