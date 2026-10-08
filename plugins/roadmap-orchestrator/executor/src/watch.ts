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
//   {"event":"answer","question","k","answer","at"}                        an owner answer (`roadmap answer`) no Phase-0 record
//                                                                          applies yet (present at start, or new; src/answers.ts)
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
// `roadmap watch --actionable [--heartbeat-min <n>]` prints only what the architect acts on (`ActionableFilter`, the one
// rule; the M4a driver resumes its headless session through it too): the key transitions plus a fixed slow heartbeat
// (owner ruling 2026-10-07: paid run 12 woke ~11 times in 65 minutes at ~$0.30 a wake, most with nothing changed). The
// key transitions: a needs-user item not seen before and not already acknowledged or superseded; an owner answer not
// seen before (by question and k, across arcs: the answer log is the repo's, so the session wakes once per answer and
// applies it at once, paid runs 12-14); a unit newly `merged`
// or newly parked (its `units` line); the run newly `held`, `blocked` or `draining`; the run reaching a terminal state
// (`complete`, `refused`, `no-owner`; once per state). The heartbeat is `{"event":"heartbeat","everyMin":<n>}` every n
// minutes (default HEARTBEAT_MIN, 30) whatever happened: the architect's organic check, no other polling. Owner lines,
// acks, superseded lines and every other unit move are absorbed. A fresh process starts with nothing seen: it re-emits
// the open items and a terminal or constrained run; the first view of an arc's units is its baseline (no unit wake).
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
import { answerNames, commonDirOfRun, unappliedAnswers } from './answers.ts';
import { NEEDS_USER_DIR, readNeedsUser, readNeedsUserAck } from './needsuser.ts';
import { SCHED_FILE } from './schedule/scheduler.ts';
import { ownerState, unitStates } from './status.ts';

export const WATCH_POLL_MS = 500;
/** The default `--heartbeat-min`: the fixed slow cadence of `--actionable`'s heartbeat line. */
export const HEARTBEAT_MIN = 30;

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

/** A unit state that is a key transition on entry: merged, or parked (any class). */
const keyState = (state: string): 'merged' | 'parked' | null => (state === 'merged' ? 'merged' : state.startsWith('parked:') ? 'parked' : null);

/**
 * The one rule of what is actionable in a watch stream (see the header). It lives across watch processes when its owner
 * keeps it (the M4a driver feeds one instance every raw stream of a run), so a restarted watch wakes nothing twice. The
 * heartbeat clock runs from construction at a fixed cadence: wakes do not move it.
 */
export class ActionableFilter {
  private readonly items = new Set<string>();
  private readonly answers = new Set<string>();
  private readonly acked = new Set<string>();
  private readonly terminal = new Set<string>();
  private readonly runs = new Map<string, string>();
  private readonly units = new Map<string, Readonly<Record<string, string>>>();
  private readonly everyMin: number;
  private nextHeartbeat: number;
  constructor(now: number, heartbeatMin: number) {
    if (!Number.isSafeInteger(heartbeatMin) || heartbeatMin < 1) throw new Error(`heartbeat minutes must be a positive integer, got ${heartbeatMin}`);
    this.everyMin = heartbeatMin;
    this.nextHeartbeat = now + heartbeatMin * 60_000;
  }

  /** The line itself when it is actionable, else null. */
  feed(arc: string, line: string): string | null {
    const e = JSON.parse(line) as { event: string; id?: string; run?: string; units?: Record<string, string>; question?: string; k?: number };
    if (e.event === 'answer') {
      const key = `${e.question}#${e.k}`;
      if (this.answers.has(key)) return null;
      this.answers.add(key);
      return line;
    }
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
    if (e.event !== 'units' || e.run === undefined || e.units === undefined) return null;
    const previousRun = this.runs.get(arc);
    const previousUnits = this.units.get(arc);
    this.runs.set(arc, e.run);
    this.units.set(arc, e.units);
    if (TERMINAL_RUN.includes(e.run)) {
      if (this.terminal.has(`${arc}:${e.run}`)) return null;
      this.terminal.add(`${arc}:${e.run}`);
      return line;
    }
    if (CONSTRAINT_RUN.includes(e.run) && e.run !== previousRun) return line;
    if (previousUnits === undefined) return null;
    const landed = Object.entries(e.units).some(([unit, state]) => {
      const key = keyState(state);
      const before = previousUnits[unit];
      return key !== null && (before === undefined || keyState(before) !== key);
    });
    return landed ? line : null;
  }

  /** The heartbeat line when one is due (then the next is due a full period from now), else null. */
  heartbeat(now: number): string | null {
    if (now < this.nextHeartbeat) return null;
    this.nextHeartbeat = now + this.everyMin * 60_000;
    return canonicalJson({ event: 'heartbeat', everyMin: this.everyMin });
  }

  /** Whether `arc` already reached a terminal state this filter passed on. */
  ended(arc: string): boolean {
    return [...this.terminal].some((t) => t.startsWith(`${arc}:`));
  }
}

/** `roadmap watch --actionable`: `watch` through an `ActionableFilter`, plus its heartbeat every `heartbeatMin` minutes. */
export async function watchActionable(
  runDir: AbsPath, arc: ArcId, hostDir: AbsPath, heartbeatMin: number, emit: (line: string) => void, signal: AbortSignal,
): Promise<void> {
  const filter = new ActionableFilter(Date.now(), heartbeatMin);
  const pass = (line: string): void => {
    const out = filter.feed(arc, line);
    if (out !== null) emit(out);
  };
  await watch(runDir, arc, hostDir, pass, signal, () => {
    const beat = filter.heartbeat(Date.now());
    if (beat !== null) emit(beat);
  });
}

/**
 * Polls until `signal` aborts; `emit` receives each event line (without its newline). `afterPoll` (`--actionable`'s
 * heartbeat check) runs once after every poll.
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
  const common = commonDirOfRun(runDir);
  let answerKey: string | null = null;
  const seenAnswers = new Set<string>();
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
    const answers = answerNames(common).join(' ');
    if (answers !== answerKey) {
      answerKey = answers;
      for (const a of answers === '' ? [] : unappliedAnswers(common)) {
        if (seenAnswers.has(`${a.question}#${a.k}`)) continue;
        seenAnswers.add(`${a.question}#${a.k}`);
        emit(canonicalJson({ event: 'answer', question: a.question, k: a.k, answer: a.answer, at: a.at }));
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
