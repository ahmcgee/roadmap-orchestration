// `roadmap watch`: the architect agent's event stream for one run. It polls the run's `needs-user/` dir, the
// host owner's liveness and the parallel view, and prints one JSON line per event on stdout (agent-facing:
// minimal, no prose). It runs until its signal aborts it (the CLI wires SIGINT and SIGTERM); the watching
// agent owns the timeout.
//
//   {"event":"needs-user","id","blocking","reason","subject","summary"}   a raised item (present at start, or new)
//   {"event":"ack","id","command","choice"}                                an acknowledgement file
//   {"event":"owner","state":"alive"|"dead"|"none","generation","pid"}     on the first poll and every change
//   {"event":"units","run":<run.state>,"units":{<unit>:<state>}}           on the first poll and every change
//
// A unit's state is `status`'s, compact (`compactState`): `running:build#3`, `waiting:deps=u1`,
// `waiting:resources`, `awaiting-admission:paused`, `parked:retryable`, `merged`… The view is re-derived
// only when the log, sched.json, the needs-user dir or the owner changed. Owner liveness is `status`'s
// (`ownerState`).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ArcId, needsUserId } from './core/ids.ts';
import { canonicalJson } from './core/json.ts';
import { EVENTS_FILE } from './core/log.ts';
import type { AbsPath } from './core/values.ts';
import { NEEDS_USER_DIR, readNeedsUser, readNeedsUserAck } from './needsuser.ts';
import { SCHED_FILE } from './schedule/scheduler.ts';
import { ownerState, unitStates } from './status.ts';

export const WATCH_POLL_MS = 500;

const ITEM = /^((?:nu|sup|host)-[a-z0-9-]+)\.json$/;
const ACK = /^((?:nu|sup|host)-[a-z0-9-]+)\.ack\.json$/;

/** What the parallel view is derived from, cheaply: when none of it changed, neither did the view. */
function viewKey(runDir: AbsPath, names: readonly string[], owner: string): string {
  const stamp = (name: string): string => {
    const path = join(runDir, name);
    if (!existsSync(path)) return '-';
    const s = statSync(path);
    return `${s.size}@${s.mtimeMs}`;
  };
  return `${stamp(EVENTS_FILE)} ${stamp(SCHED_FILE)} ${names.length} ${owner}`;
}

/** Polls until `signal` aborts; `emit` receives each event line (without its newline). */
export async function watch(runDir: AbsPath, arc: ArcId, hostDir: AbsPath, emit: (line: string) => void, signal: AbortSignal): Promise<void> {
  const seenItems = new Set<string>();
  const seenAcks = new Set<string>();
  let owner: string | null = null;
  let key: string | null = null;
  let units: string | null = null;
  const dir = join(runDir, NEEDS_USER_DIR);
  while (!signal.aborted) {
    const names = existsSync(dir) ? readdirSync(dir).sort() : [];
    for (const name of names) {
      const item = ITEM.exec(name);
      if (item !== null && !seenItems.has(item[1] as string)) {
        const n = readNeedsUser(runDir, needsUserId(item[1]));
        if (n === null) throw new Error(`${join(dir, name)} vanished while watching; needs-user files are write-once`);
        seenItems.add(n.id);
        emit(canonicalJson({ event: 'needs-user', id: n.id, blocking: n.blocking, reason: n.reason, subject: n.subject, summary: n.summary }));
      }
      const ack = ACK.exec(name);
      if (ack !== null && !seenAcks.has(ack[1] as string)) {
        const a = readNeedsUserAck(runDir, needsUserId(ack[1]));
        if (a === null) throw new Error(`${join(dir, name)} vanished while watching; acknowledgements are write-once`);
        seenAcks.add(a.id);
        emit(canonicalJson({ event: 'ack', id: a.id, command: a.command, choice: a.choice }));
      }
    }
    const state = canonicalJson({ event: 'owner', ...ownerState(runDir, hostDir) });
    if (state !== owner) {
      owner = state;
      emit(state);
    }
    const next = viewKey(runDir, names, state);
    if (next !== key) {
      key = next;
      const line = canonicalJson({ event: 'units', ...unitStates(runDir, arc, hostDir) });
      if (line !== units) {
        units = line;
        emit(line);
      }
    }
    try {
      await sleep(WATCH_POLL_MS, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
