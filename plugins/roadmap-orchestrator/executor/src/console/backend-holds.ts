// D8 projection of recorded availability boundaries, not an execution-state fold.
// Mirrors state.ts backend-park/#probe/#resumed: usage-limit dominates until manual resume.
import { RETRYABLE_BACKEND_PARKS, type Event } from '../core/events.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import type { BackendHold, ActivityKind } from './activity-protocol.ts';

export const activityKey = (epoch: string, seq: number, kind: ActivityKind) => `${sha256Hex(epoch).slice(0, 24)}-${seq}-${kind}`;
/** `terminal`: the fact that ends the arc's record (tokens.ts `arcTerminal`), which closes a hold still open at it. */
export function backendHolds(events: readonly Event[], epoch: string, terminal: Extract<Event, {type: 'fact'}> | null): BackendHold[] {
  const rows: BackendHold[] = [], current = new Map<string, BackendHold>();
  for (const ev of events) {
    if (ev.type !== 'fact') continue;
    const f = ev.fact;
    const close = (backend: string, kind: 'resumed' | 'probe' | 'park-updated') => {
      const hold = current.get(backend); if (!hold) return;
      hold.endedAt = ev.at;
      hold.closure = {kind, seq: ev.seq, at: ev.at, detail: {type: 'event', id: activityKey(epoch, ev.seq, kind === 'park-updated' ? 'backend-park' : 'backend-closure')}};
      current.delete(backend);
    };
    if (f.kind === 'backend-park') {
      const prior = current.get(f.backend), effectiveClass = prior?.effectiveClass === 'usage-limit' ? 'usage-limit' : f.class;
      // A new epoch continues the same unavailable period; this boundary never claims availability.
      close(f.backend, 'park-updated');
      const id = activityKey(epoch, ev.seq, 'backend-park');
      const hold: BackendHold = {id, backend: f.backend, recordedClass: f.class, effectiveClass,
        invocation: f.inv === null ? null : invocationDirName(invocationIdOf(f.inv)), startSeq: ev.seq, startedAt: ev.at,
        endedAt: null, closure: null, terminalAt: terminal && terminal.seq >= ev.seq ? terminal.at : null, detail: {type: 'event', id}};
      rows.push(hold); current.set(f.backend, hold);
    } else if (f.kind === 'resumed' && f.target.type === 'backend') close(f.target.backend, 'resumed');
    else if (f.kind === 'probe' && f.target.type === 'backend' && f.result === 'pass') {
      const hold = current.get(f.target.backend);
      if (hold && f.covers.includes(hold.startSeq) && (RETRYABLE_BACKEND_PARKS as readonly string[]).includes(hold.effectiveClass)) close(f.target.backend, 'probe');
    }
  }
  return rows;
}
