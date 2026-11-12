import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../core/json.ts';
import { ConsoleError } from '../observation/protocol.ts';

// A first read answers within a quarter second, so cold work yields promptly. A poll carrying
// its pending token is held until the read completes, for at most retryAfterMs, so a read that
// misses the first window arrives as soon as it is ready rather than after a fixed second.
export const PREPARATION = { deadlineMs: 250, retryAfterMs: 1000, lifetimeMs: 30_000, graceMs: 1000, maxReads: 32, maxSubscribers: 128 } as const;
type Read = { id: string; key: string; expires: number; subscribers: Set<string>; task: Promise<void>; result?: {value: unknown} | {error: unknown};
  run: (signal: AbortSignal) => Promise<unknown>; controller: AbortController };
type Subscriber = { read: Read; exposed: boolean; delivered: boolean; expires: number };
export type Prepared = {state: 'preparing'; pending: string; retryAfterMs: number} | {state: 'ready'; value: unknown};

/** One bounded delivery coordinator, not an observation cache. Equivalent readers share work,
 * but have separate cancellation leases. Only the worker can admit an observation, and a settled read is delivered as the
 * worker admitted it, whatever its age: the envelope carries its own `checkedAt`, and the browser says how old it is. A 202
 * means the read is still running, so a poll carrying its token is held until it settles, for at most retryAfterMs.
 * Reads run at once and side by side: the serve worker answers from memory and parks a read it cannot answer yet without
 * holding up any other. A read every reader has left (a cancelled hover card or drawer) is aborted, and the serve worker
 * drops it, so nothing is computed for a reader who left. */
export class BrowserPreparation {
  #reads = new Map<string, Read>();
  #subscribers = new Map<string, Subscriber>();
  #timer = setInterval(() => this.#sweep(), 1000).unref();
  close() { clearInterval(this.#timer); for (const r of this.#reads.values()) r.controller.abort(); this.#reads.clear(); this.#subscribers.clear(); }
  #remove(token: string) {
    const s = this.#subscribers.get(token); if (!s) return;
    this.#subscribers.delete(token); s.read.subscribers.delete(token);
    if (s.read.subscribers.size) return;
    // A read still running is aborted and counted until it settles: abandonment cannot create unbounded worker tasks.
    if (s.read.result) this.#reads.delete(s.read.id); else s.read.controller.abort();
  }
  #sweep() { for (const [token, s] of this.#subscribers) if (Math.min(s.expires, s.read.expires) <= Date.now()) this.#remove(token); }
  #start(read: Read) {
    const controller = read.controller = new AbortController();
    read.task = Promise.resolve().then(() => read.run(controller.signal)).then(value => { read.result = {value}; }, error => { read.result = {error}; })
      .then(() => { if (!read.subscribers.size) this.#reads.delete(read.id); });
  }
  async read(identity: unknown, run: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal, token?: string, cancel = false): Promise<Prepared> {
    this.#sweep();
    const key = canonicalJson(identity);
    const polled = token !== undefined;
    let s: Subscriber;
    if (token !== undefined) {
      if (!/^[0-9a-f-]{36}$/.test(token)) throw new ConsoleError('invalid', 'invalid preparation token');
      const known = this.#subscribers.get(token);
      // Cancelling twice, or after the lease ended, is still a cancellation: never an error for a reader who left.
      if (!known && cancel) return {state: 'ready', value: {state: 'cancelled'}};
      if (!known) throw new ConsoleError('unavailable', 'preparation expired or cancelled; retry this view');
      if (known.read.key !== key) throw new ConsoleError('invalid', 'preparation token does not match this route and query');
      s = known;
      if (cancel) { this.#remove(token); return {state: 'ready', value: {state: 'cancelled'}}; }
    } else {
      if (cancel) throw new ConsoleError('invalid', 'cancellation requires a preparation token');
      if (this.#subscribers.size >= PREPARATION.maxSubscribers) throw new ConsoleError('unavailable', 'too many browser readers; retry');
      let read = [...this.#reads.values()].find(r => r.key === key && !r.result && !r.controller.signal.aborted);
      if (!read) {
        if (this.#reads.size >= PREPARATION.maxReads) throw new ConsoleError('unavailable', 'too many browser reads preparing; retry');
        read = {id: randomUUID(), key, expires: Date.now() + PREPARATION.lifetimeMs, subscribers: new Set(), task: Promise.resolve(), run, controller: new AbortController()};
        this.#reads.set(read.id, read); this.#start(read);
      }
      token = randomUUID(); s = {read, exposed: false, delivered: false, expires: read.expires};
      read.subscribers.add(token); this.#subscribers.set(token, s);
    }
    const lease = token;
    const abort = () => this.#remove(lease);
    signal.addEventListener('abort', abort, {once: true});
    let timer: NodeJS.Timeout | undefined;
    try {
      if (signal.aborted) { abort(); throw new ConsoleError('unavailable', 'browser read cancelled'); }
      const hold = Math.min(polled ? PREPARATION.retryAfterMs : PREPARATION.deadlineMs, Math.max(0, s.read.expires - Date.now()));
      await Promise.race([s.read.task, new Promise<void>(resolve => {
        timer = setTimeout(resolve, hold); signal.addEventListener('abort', () => resolve(), {once: true});
      })]);
      if (signal.aborted || !this.#subscribers.has(lease)) throw new ConsoleError('unavailable', 'browser read cancelled');
      if (Date.now() >= s.read.expires) { this.#remove(lease); throw new ConsoleError('unavailable', 'browser preparation exceeded thirty seconds; retry'); }
      if (!s.read.result) { s.exposed = true; return {state: 'preparing', pending: lease, retryAfterMs: PREPARATION.retryAfterMs}; }
      s.expires = s.delivered ? s.expires : Math.min(s.read.expires, Date.now() + PREPARATION.graceMs);
      s.delivered = true;
      if (!s.exposed) this.#remove(lease);
      if ('error' in s.read.result) throw s.read.result.error;
      return {state: 'ready', value: s.read.result.value};
    } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
}
