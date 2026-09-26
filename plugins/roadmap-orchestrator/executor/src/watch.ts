// `roadmap watch`: the architect agent's event stream for one run. It polls the run's `needs-user/` dir and
// the host owner's liveness and prints one JSON line per event on stdout (agent-facing: minimal, no prose).
// It runs until its signal aborts it (the CLI wires SIGINT and SIGTERM); the watching agent owns the timeout.
//
//   {"event":"needs-user","id","blocking","reason","subject","summary"}   a raised item (present at start, or new)
//   {"event":"ack","id","command","choice"}                                an acknowledgement file
//   {"event":"owner","state":"alive"|"dead"|"none","generation","pid"}     on the first poll and every change
//
// Owner liveness is the host claim's: this run's claim (host.lock names this run dir) with host.owner.json
// naming a live executor on the claim's boot is `alive`; a claim for this run whose executor is gone (or
// never spawned) is `dead`; no claim for this run is `none`.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { needsUserId } from './core/ids.ts';
import { canonicalJson } from './core/json.ts';
import type { AbsPath } from './core/values.ts';
import { readClaim } from './host/lock.ts';
import { isAlive } from './host/liveness.ts';
import { readOwner } from './host/owner.ts';
import { NEEDS_USER_DIR, readNeedsUser, readNeedsUserAck } from './needsuser.ts';

export const WATCH_POLL_MS = 500;

const ITEM = /^((?:nu|sup|host)-[a-z0-9-]+)\.json$/;
const ACK = /^((?:nu|sup|host)-[a-z0-9-]+)\.ack\.json$/;

export type OwnerState = Readonly<{ state: 'alive' | 'dead' | 'none'; generation: number | null; pid: number | null }>;

export function ownerState(runDir: AbsPath, hostDir: AbsPath): OwnerState {
  const claim = readClaim(hostDir);
  if (claim === null || claim.runDir !== runDir) return { state: 'none', generation: null, pid: null };
  const owner = readOwner(hostDir);
  const executor = owner !== null && owner.nonce === claim.nonce ? owner.executor : null;
  if (executor === null) return { state: 'dead', generation: claim.generation, pid: null };
  return { state: isAlive(executor, claim.bootId) ? 'alive' : 'dead', generation: claim.generation, pid: executor.pid };
}

/** Polls until `signal` aborts; `emit` receives each event line (without its newline). */
export async function watch(runDir: AbsPath, hostDir: AbsPath, emit: (line: string) => void, signal: AbortSignal): Promise<void> {
  const seenItems = new Set<string>();
  const seenAcks = new Set<string>();
  let owner: string | null = null;
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
    try {
      await sleep(WATCH_POLL_MS, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
