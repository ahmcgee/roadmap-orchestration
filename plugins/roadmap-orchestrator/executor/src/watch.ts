// `roadmap watch`: the architect agent's event stream for one run. It polls the run's `needs-user/` dir, the
// host owner's liveness and the parallel view, and prints one JSON line per event on stdout (agent-facing:
// minimal, no prose). It runs until its signal aborts it (the CLI wires SIGINT and SIGTERM); the watching
// agent owns the timeout.
//
//   {"event":"needs-user","id","blocking","reason","subject","summary"}   a raised item (present at start, or new)
//   {"event":"ack","id","command","choice"}                                an acknowledgement file
//   {"event":"owner","state":"alive"|"dead"|"none","generation","pid"}     on the first poll and every change
//   {"event":"units","run":<run.state>,"units":{<unit>:<state>}}           on the first poll and every change
//   {"event":"superseded","id"}                                            an item a later one superseded (K14: a pack review's)
//
// A `superseded` line comes before any `needs-user` line of its poll, as an ack file sorts before its item: a reader that
// drops answered items (`--actionable`) sees the answer first (paid M4a run 10, R-17).
//
// Every raised item is a `needs-user` line, blocking or not: the Monitor wakes the session on each (DESIGN §2), so the
// holistic layer's items wake it as any other does: `owner-request`, the `divergence-digest`, the `convergence-bound`
// and `convergence-identity` brakes, `audit-owed`, `finding-p1-escalated` and `new-finding-draining` (test
// watch.m3-kinds), and M4a's blocking `pack-review` and `issue-policy-untrusted`. `run` may be `draining` (admissions
// closed). A headless driver resumes its session on these lines and on `run` reaching `complete` (M4a R12).
//
// `roadmap watch --actionable` (run 10, B) prints only what the architect acts on (`ActionableFilter`, the one rule; the
// M4a driver resumes its headless session through it too): a needs-user item not seen before and not already
// acknowledged or superseded, the run reaching a terminal state (`complete`, `refused`, `no-owner`; once per state), a changed
// constraint (the run newly `held`, `blocked` or `draining`), and `{"event":"stall","quietMin":30}` after STALL_MIN
// minutes with no change of the parallel view (once per quiet stretch). Owner lines, acks and routine unit moves are
// absorbed. A fresh process starts with nothing seen: it re-emits the open items and a terminal or constrained run.
//
// A unit's state is `status`'s, compact (`compactState`): `running:build#3`, `waiting:deps=u1`,
// `waiting:resources`, `awaiting-admission:paused`, `awaiting-admission:known-defect` (M4a rev 3: held at prepare by a
// plan known defect until its fixer merges), `parked:retryable`, `merged`… The view is re-derived
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
/** Minutes without a change of the parallel view after which `--actionable` reports a stall. */
export const STALL_MIN = 30;

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

/** Run states that end a wait: nothing more happens without the architect. */
const TERMINAL_RUN: readonly string[] = ['complete', 'refused', 'no-owner'];
/** Run states that are a changed constraint: paused or a parked backend (held), work waiting on the architect (blocked), admissions closed (draining). */
const CONSTRAINT_RUN: readonly string[] = ['held', 'blocked', 'draining'];

/** A needs-user item's key across arcs: ids are arc-scoped. */
export const itemKey = (arc: string, id: string): string => `${arc}:${id}`;

/**
 * The one rule of what is actionable in a watch stream (see the header). It lives across watch processes when its owner
 * keeps it (the M4a driver feeds one instance every raw stream of a run), so a restarted watch wakes nothing twice.
 */
export class ActionableFilter {
  private readonly items = new Set<string>();
  private readonly acked = new Set<string>();
  private readonly terminal = new Set<string>();
  private run: string | null = null;
  private units: string | null = null;
  private changedAt: number;
  constructor(now: number) {
    this.changedAt = now;
  }

  /** The line itself when it is actionable, else null. */
  feed(arc: string, line: string, now: number): string | null {
    const e = JSON.parse(line) as { event: string; id?: string; run?: string };
    if ((e.event === 'ack' || e.event === 'superseded') && e.id !== undefined) {
      this.acked.add(itemKey(arc, e.id));
      return null;
    }
    if (e.event === 'needs-user' && e.id !== undefined) {
      const key = itemKey(arc, e.id);
      if (this.items.has(key) || this.acked.has(key)) return null;
      this.items.add(key);
      return line;
    }
    if (e.event !== 'units' || e.run === undefined) return null;
    if (line !== this.units) this.changedAt = now;
    this.units = line;
    const previous = this.run;
    this.run = e.run;
    if (TERMINAL_RUN.includes(e.run)) {
      if (this.terminal.has(`${arc}:${e.run}`)) return null;
      this.terminal.add(`${arc}:${e.run}`);
      return line;
    }
    return CONSTRAINT_RUN.includes(e.run) && e.run !== previous ? line : null;
  }

  /** Whether the parallel view has not changed for STALL_MIN minutes (since the last change or wake). */
  stalled(now: number): boolean {
    return now - this.changedAt >= STALL_MIN * 60_000;
  }

  /** A wake went out: the stall clock restarts. */
  woke(now: number): void {
    this.changedAt = now;
  }

  /** Whether `arc` already reached a terminal state this filter passed on. */
  ended(arc: string): boolean {
    return [...this.terminal].some((t) => t.startsWith(`${arc}:`));
  }
}

/** The stall line `--actionable` prints. */
export const stallLine = (): string => canonicalJson({ event: 'stall', quietMin: STALL_MIN });

/** `roadmap watch --actionable`: `watch` through an `ActionableFilter`, plus a stall line per quiet stretch. */
export async function watchActionable(runDir: AbsPath, arc: ArcId, hostDir: AbsPath, emit: (line: string) => void, signal: AbortSignal): Promise<void> {
  const filter = new ActionableFilter(Date.now());
  const pass = (line: string): void => {
    const out = filter.feed(arc, line, Date.now());
    if (out === null) return;
    filter.woke(Date.now());
    emit(out);
  };
  await watch(runDir, arc, hostDir, pass, signal, () => {
    if (!filter.stalled(Date.now())) return;
    filter.woke(Date.now());
    emit(stallLine());
  });
}

/**
 * Polls until `signal` aborts; `emit` receives each event line (without its newline). `afterPoll` (`--actionable`'s
 * stall check) runs once after every poll.
 */
export async function watch(
  runDir: AbsPath, arc: ArcId, hostDir: AbsPath, emit: (line: string) => void, signal: AbortSignal, afterPoll: () => void = () => {},
): Promise<void> {
  const seenItems = new Set<string>();
  const seenAcks = new Set<string>();
  const seenSuperseded = new Set<string>();
  let owner: string | null = null;
  let key: string | null = null;
  let units: string | null = null;
  let view: ReturnType<typeof unitStates> | null = null;
  const dir = join(runDir, NEEDS_USER_DIR);
  while (!signal.aborted) {
    const names = existsSync(dir) ? readdirSync(dir).sort() : [];
    const state = canonicalJson({ event: 'owner', ...ownerState(runDir, hostDir) });
    const next = viewKey(runDir, names, state);
    if (next !== key || view === null) {
      key = next;
      view = unitStates(runDir, arc, hostDir);
    }
    for (const id of view.superseded) {
      if (seenSuperseded.has(id)) continue;
      seenSuperseded.add(id);
      emit(canonicalJson({ event: 'superseded', id }));
    }
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
    if (state !== owner) {
      owner = state;
      emit(state);
    }
    const line = canonicalJson({ event: 'units', run: view.run, units: view.units });
    if (line !== units) {
      units = line;
      emit(line);
    }
    afterPoll();
    try {
      await sleep(WATCH_POLL_MS, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
