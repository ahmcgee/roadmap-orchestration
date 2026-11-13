// D8 projection of recorded availability boundaries, not an execution-state fold.
// Mirrors state.ts backend-park/#probe/#resumed: usage-limit dominates until manual resume.
import { RETRYABLE_BACKEND_PARKS, type Event } from '../core/events.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import type { BackendHold, ActivityKind } from './activity-protocol.ts';

type FactEvent = Extract<Event, {type: 'fact'}>;
/** The Activity entry ids of one epoch: `<epoch digest>-<seq>-<kind>`, the digest computed once. */
export const activityKeys = (epoch: string): ((seq: number, kind: ActivityKind) => string) => {
  const prefix = sha256Hex(epoch).slice(0, 24);
  return (seq, kind) => `${prefix}-${seq}-${kind}`;
};
export const activityKey = (epoch: string, seq: number, kind: ActivityKind) => activityKeys(epoch)(seq, kind);
/**
 * The holds folded event by event (`fold`), as the Activity index keeps them (src/console/activity-index.ts). A hold's
 * start and its closing boundary are known at their own events; only `terminalAt` reads the journal as it stands, so
 * `holds` stamps it from the terminal fact given.
 */
export class BackendHoldFold {
  readonly #key: (seq: number, kind: ActivityKind) => string;
  readonly #rows: BackendHold[] = [];
  readonly #current = new Map<string, BackendHold>();
  /** The hold each backend-park event started, and the hold each closing event closed (not a park's own update). */
  readonly starts = new Map<number, BackendHold>();
  readonly closures = new Map<number, BackendHold>();
  constructor(epoch: string) { this.#key = activityKeys(epoch); }
  /** Folds `ev`; true when it started or closed a hold. */
  fold(ev: Event): boolean {
    if (ev.type !== 'fact') return false;
    const f = ev.fact;
    const close = (backend: string, kind: 'resumed' | 'probe' | 'park-updated'): boolean => {
      const hold = this.#current.get(backend); if (!hold) return false;
      hold.endedAt = ev.at;
      hold.closure = {kind, seq: ev.seq, at: ev.at, detail: {type: 'event', id: this.#key(ev.seq, kind === 'park-updated' ? 'backend-park' : 'backend-closure')}};
      this.#current.delete(backend);
      if (kind !== 'park-updated' && !this.closures.has(ev.seq)) this.closures.set(ev.seq, hold);
      return true;
    };
    if (f.kind === 'backend-park') {
      const prior = this.#current.get(f.backend), effectiveClass = prior?.effectiveClass === 'usage-limit' ? 'usage-limit' : f.class;
      // A new epoch continues the same unavailable period; this boundary never claims availability.
      close(f.backend, 'park-updated');
      const id = this.#key(ev.seq, 'backend-park');
      const hold: BackendHold = {id, backend: f.backend, recordedClass: f.class, effectiveClass,
        invocation: f.inv === null ? null : invocationDirName(invocationIdOf(f.inv)), startSeq: ev.seq, startedAt: ev.at,
        endedAt: null, closure: null, terminalAt: null, detail: {type: 'event', id}};
      this.#rows.push(hold); this.#current.set(f.backend, hold);
      if (!this.starts.has(ev.seq)) this.starts.set(ev.seq, hold);
      return true;
    }
    if (f.kind === 'resumed' && f.target.type === 'backend') return close(f.target.backend, 'resumed');
    if (f.kind === 'probe' && f.target.type === 'backend' && f.result === 'pass') {
      const hold = this.#current.get(f.target.backend);
      if (hold && f.covers.includes(hold.startSeq) && (RETRYABLE_BACKEND_PARKS as readonly string[]).includes(hold.effectiveClass)) return close(f.target.backend, 'probe');
    }
    return false;
  }
  /** The holds as of the events folded, each a copy: `terminal` (tokens.ts `arcTerminal`) closes a hold still open at it. */
  holds(terminal: FactEvent | null): BackendHold[] {
    return this.#rows.map((h) => ({...h, closure: h.closure === null ? null : {...h.closure}, terminalAt: terminal && terminal.seq >= h.startSeq ? terminal.at : null}));
  }
}
/** `terminal`: the fact that ends the arc's record (tokens.ts `arcTerminal`), which closes a hold still open at it. */
export function backendHolds(events: readonly Event[], epoch: string, terminal: FactEvent | null): BackendHold[] {
  const fold = new BackendHoldFold(epoch);
  for (const ev of events) fold.fold(ev);
  return fold.holds(terminal);
}
